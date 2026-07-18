//! OS-keychain storage for provider API keys.
//!
//! Keys are stored in the platform-native secret store (Windows Credential
//! Manager / macOS Keychain / Linux secret service) rather than in the plaintext
//! `settings.json`. This module owns the only keyring touchpoints; `settings.rs`
//! calls [`scrub`] / [`rehydrate`] on save/load and never handles keyring types
//! directly.
//!
//! Entry ids are stable per-provider: `chat::{provider.id}` and
//! `embedding::{provider.id}`. The provider `id` is the existing stable React
//! key (never empty), so renaming a provider keeps its key. Deleting a provider
//! leaves its keychain entry behind (a harmless orphan); this module does not
//! expose a forget hook.
//!
//! A swappable [`Store`] trait lets tests substitute an in-memory backend; the
//! production code uses [`with_store`] against the OS keychain.

use std::sync::OnceLock;

#[cfg(test)]
use std::sync::Mutex;

use serde_json::Value;

/// The keyring service name. Entries are namespaced under this so the app's
/// secrets don't collide with other applications on the same OS account.
const SERVICE: &str = "artefact-cataloguer";

/// A minimal secret store. Production uses the OS keychain; tests inject an
/// in-memory implementation.
pub trait Store: Send + Sync {
    /// Persist `secret` under `entry_id`. Returns `Err` only on a backend
    /// failure the caller may want to fall back from.
    fn set(&self, entry_id: &str, secret: &str) -> Result<(), String>;
    /// Read `secret` for `entry_id`. `None` means "no entry" (first run, or a
    /// shared settings file whose key didn't travel). Backend errors are logged
    /// and treated as `None` so a flaky keychain never crashes a parse run.
    fn get(&self, entry_id: &str) -> Option<String>;
}

// ---------------------------------------------------------------------------
// Entry-id construction — stable per provider id.

/// Build the keychain entry id for a chat/vision provider.
pub fn chat_entry_id(provider_id: &str) -> String {
    format!("chat::{provider_id}")
}

/// Build the keychain entry id for an embedding provider.
pub fn embedding_entry_id(provider_id: &str) -> String {
    format!("embedding::{provider_id}")
}

// ---------------------------------------------------------------------------
// Production store (OS keychain) + process-wide singleton.

struct KeyringStore;

/// True if a keyring error represents "no such entry" (the expected case for a
/// first run or a shared settings file whose key didn't travel). Matched via
/// the `Display` representation rather than `keyring::Error::NoEntry` directly
/// — the error enum's exact path/variant has shifted across keyring versions,
/// but its displayed text ("No matching entry" / "No entry found" / similar)
/// has stayed stable, and string-matching degrades gracefully if the variant
/// is renamed again. Any string mismatch is treated as a real error (logged),
/// never silently as "missing" — so the worst case of a string-match miss is a
/// logged error and a "missing key" fallback, not incorrect behaviour.
fn is_no_entry_error(e: &keyring::Error) -> bool {
    let msg = format!("{e}").to_ascii_lowercase();
    msg.contains("no matching entry")
        || msg.contains("no entry")
        || msg.contains("not found")
        || msg.contains("doesn't exist")
}

impl Store for KeyringStore {
    fn set(&self, entry_id: &str, secret: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, entry_id)
            .and_then(|e| e.set_password(secret))
            .map_err(|e| e.to_string())
    }

    fn get(&self, entry_id: &str) -> Option<String> {
        match keyring::Entry::new(SERVICE, entry_id).and_then(|e| e.get_password()) {
            Ok(s) => Some(s),
            Err(e) if is_no_entry_error(&e) => None,
            Err(e) => {
                // Swallow non-NoEntry failures so a flaky backend degrades
                // gracefully (the provider reads as "missing key").
                eprintln!("[artefact] keychain read failed for {entry_id}: {e}");
                None
            }
        }
    }
}

/// The production store (OS keychain), lazily initialised.
static STORE: OnceLock<Box<dyn Store>> = OnceLock::new();

/// Test-only override slot. A `Mutex<Option<…>>` (not `OnceLock`) so each test
/// can install a fresh in-memory store and clear it on teardown — `OnceLock`
/// is one-shot and would leak state between tests in the same binary. Tests
/// never touch the real OS keychain.
#[cfg(test)]
static TEST_STORE: Mutex<Option<Box<dyn Store>>> = Mutex::new(None);

/// Acquire the active store for one call. Tests can substitute an in-memory
/// backend via [`set_store_for_tests`]; production uses the OS keychain. The
/// test branch holds the `TEST_STORE` `Mutex` guard for the call's duration so
/// the `Box` can't be replaced mid-call; production borrows the `OnceLock`'s
/// `&'static`.
fn with_store<R>(f: impl FnOnce(&dyn Store) -> R) -> R {
    #[cfg(test)]
    {
        let guard = TEST_STORE.lock().unwrap();
        if let Some(store) = guard.as_ref() {
            return f(store.as_ref());
        }
    }
    f(STORE.get_or_init(|| Box::new(KeyringStore)).as_ref())
}

/// Test-only: substitute an in-memory store so tests don't touch the OS
/// keychain. Each call replaces the previous store (so tests are isolated);
/// pass `None` to clear. Production code never calls this.
#[cfg(test)]
pub fn set_store_for_tests(store: Option<Box<dyn Store>>) {
    *TEST_STORE.lock().unwrap() = store;
}

/// Persist a key. `Err` signals a backend failure (caller falls back to
/// plaintext to avoid losing the key).
pub fn set_key(entry_id: &str, key: &str) -> Result<(), String> {
    with_store(|s| s.set(entry_id, key))
}

/// Read a key. `None` = no entry / unreadable (degrade to "missing key").
pub fn get_key(entry_id: &str) -> Option<String> {
    with_store(|s| s.get(entry_id))
}

// ---------------------------------------------------------------------------
// settings.rs integration: scrub on save, rehydrate (+ migrate) on load.

/// Move every non-empty `apiKey` out of the in-memory settings blob into the
/// keychain, replacing each with `""` so the serialised `settings.json` never
/// holds a key in cleartext. On a keychain failure the key is left in place
/// (graceful degradation) rather than dropping it.
pub fn scrub(settings: &mut Value) {
    scrub_array(settings, "providers", chat_entry_id);
    scrub_array(settings, "embeddingProviders", embedding_entry_id);
}

fn scrub_array(settings: &mut Value, array_key: &str, entry_id: impl Fn(&str) -> String) {
    let Some(arr) = settings.get_mut(array_key).and_then(Value::as_array_mut) else {
        return;
    };
    for entry in arr.iter_mut() {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let key = entry
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if key.is_empty() {
            continue;
        }
        let entry_id = entry_id(id);
        match set_key(&entry_id, key) {
            Ok(()) => {
                if let Some(obj) = entry.as_object_mut() {
                    obj.insert("apiKey".to_string(), Value::String(String::new()));
                }
            }
            Err(e) => {
                // Leave the key in the JSON so the app still works; the
                // plaintext-at-rest risk is accepted over losing the key.
                eprintln!("[artefact] keychain write failed for {entry_id}: {e} — leaving key in settings.json");
            }
        }
    }
}

/// Reattach keys from the keychain to the in-memory settings blob. For any
/// provider whose keychain entry is absent but whose persisted `apiKey` is
/// non-empty (an older save pre-keychain, or a shared file), migrate it: write
/// it to the keychain now and scrub the in-memory copy so the next save
/// persists the scrub. Idempotent — a second load finds the keychain entry and
/// skips the migration.
pub fn rehydrate(settings: &mut Value) {
    rehydrate_array(settings, "providers", chat_entry_id);
    rehydrate_array(settings, "embeddingProviders", embedding_entry_id);
}

fn rehydrate_array(settings: &mut Value, array_key: &str, entry_id: impl Fn(&str) -> String) {
    let Some(arr) = settings.get_mut(array_key).and_then(Value::as_array_mut) else {
        return;
    };
    for entry in arr.iter_mut() {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        let entry_id = entry_id(id);
        let persisted = entry
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match get_key(&entry_id) {
            Some(k) => {
                if let Some(obj) = entry.as_object_mut() {
                    obj.insert("apiKey".to_string(), Value::String(k));
                }
            }
            None if !persisted.is_empty()
                // One-time migration: move the plaintext key into the keychain
                // and scrub the in-memory copy.
                && set_key(&entry_id, &persisted).is_ok() =>
            {
                if let Some(obj) = entry.as_object_mut() {
                    obj.insert("apiKey".to_string(), Value::String(String::new()));
                }
            }
            None => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Tests run against an in-memory store so no real OS keychain is touched.

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex as StdMutex;

    /// Tests share the global `TEST_STORE` slot, so they must not run in
    /// parallel. Every test acquires this lock for its whole body, serializing
    /// the test module. (The `#[serial]` crate would be cleaner, but pulling a
    /// dev-dependency for one module isn't worth it.)
    static TEST_LOCK: StdMutex<()> = StdMutex::new(());

    /// Simple in-memory Store for tests. Protected by a Mutex so it's Send+Sync.
    struct MemoryStore(Mutex<HashMap<String, String>>);

    impl MemoryStore {
        fn new() -> Self {
            Self(Mutex::new(HashMap::new()))
        }
    }

    impl Store for MemoryStore {
        fn set(&self, entry_id: &str, secret: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(entry_id.to_string(), secret.to_string());
            Ok(())
        }
        fn get(&self, entry_id: &str) -> Option<String> {
            self.0.lock().unwrap().get(entry_id).cloned()
        }
    }

    /// Install a fresh in-memory store and acquire the test-serialization lock
    /// for the caller's scope. Returns the guard — tests must bind it (`let _g
    /// = install_memory_store();`) so the lock (and the test store's lifetime)
    /// covers the whole test body. This serializes the whole test module since
    /// they share the global `TEST_STORE` slot.
    fn install_memory_store() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap();
        set_store_for_tests(Some(Box::new(MemoryStore::new())));
        guard
    }

    #[test]
    fn entry_ids_are_namespaced_and_stable() {
        assert_eq!(chat_entry_id("p1"), "chat::p1");
        assert_eq!(embedding_entry_id("p1"), "embedding::p1");
        assert_ne!(chat_entry_id("p1"), embedding_entry_id("p1"));
    }

    #[test]
    fn set_get_round_trip() {
        let _g = install_memory_store();
        set_key("chat::p1", "sk-abc").unwrap();
        assert_eq!(get_key("chat::p1").as_deref(), Some("sk-abc"));
    }

    #[test]
    fn get_returns_none_for_missing_entry() {
        let _g = install_memory_store();
        assert!(get_key("chat::never").is_none());
    }

    #[test]
    fn scrub_moves_keys_out_of_settings_and_into_keychain() {
        let _g = install_memory_store();
        let mut settings = serde_json::json!({
            "providers": [
                { "id": "p1", "name": "OpenAI", "apiKey": "sk-secret" },
                { "id": "p2", "name": "Empty",  "apiKey": "" }
            ],
            "embeddingProviders": [
                { "id": "e1", "name": "Emb", "apiKey": "emb-key" }
            ]
        });
        scrub(&mut settings);
        // Keys zeroed in the settings blob…
        assert_eq!(settings["providers"][0]["apiKey"].as_str(), Some(""));
        assert_eq!(settings["providers"][1]["apiKey"].as_str(), Some(""));
        assert_eq!(
            settings["embeddingProviders"][0]["apiKey"].as_str(),
            Some("")
        );
        // …and present in the keychain under the namespaced ids.
        assert_eq!(get_key("chat::p1").as_deref(), Some("sk-secret"));
        assert_eq!(get_key("embedding::e1").as_deref(), Some("emb-key"));
        // An empty key is not stored (no spurious keychain entry).
        assert!(get_key("chat::p2").is_none());
    }

    #[test]
    fn rehydrate_reattaches_keys_from_keychain() {
        let _g = install_memory_store();
        set_key("chat::p1", "sk-restored").unwrap();
        let mut settings = serde_json::json!({
            "providers": [ { "id": "p1", "apiKey": "" } ]
        });
        rehydrate(&mut settings);
        assert_eq!(
            settings["providers"][0]["apiKey"].as_str(),
            Some("sk-restored")
        );
    }

    #[test]
    fn rehydrate_migrates_a_plaintext_key_on_first_load() {
        // A pre-keychain settings file: non-empty apiKey, no keychain entry.
        let _g = install_memory_store();
        let mut settings = serde_json::json!({
            "providers": [ { "id": "p1", "apiKey": "sk-legacy" } ]
        });
        rehydrate(&mut settings);
        // Key moved into the keychain…
        assert_eq!(get_key("chat::p1").as_deref(), Some("sk-legacy"));
        // …and scrubbed from the in-memory blob (next save persists the scrub).
        assert_eq!(settings["providers"][0]["apiKey"].as_str(), Some(""));
    }

    #[test]
    fn rehydrate_is_idempotent_after_migration() {
        let _g = install_memory_store();
        let mut settings = serde_json::json!({
            "providers": [ { "id": "p1", "apiKey": "sk-once" } ]
        });
        rehydrate(&mut settings); // migrates + scrubs
                                  // Second pass finds the keychain entry, reattaches, no double-migration.
        rehydrate(&mut settings);
        assert_eq!(settings["providers"][0]["apiKey"].as_str(), Some("sk-once"));
        assert_eq!(get_key("chat::p1").as_deref(), Some("sk-once"));
    }

    #[test]
    fn scrub_then_rehydrate_round_trips() {
        // The full save→load cycle: scrub on save, rehydrate on load, key survives.
        let _g = install_memory_store();
        let mut settings = serde_json::json!({
            "providers": [ { "id": "p1", "apiKey": "sk-roundtrip" } ]
        });
        scrub(&mut settings); // simulate save
        assert_eq!(settings["providers"][0]["apiKey"].as_str(), Some(""));
        rehydrate(&mut settings); // simulate load
        assert_eq!(
            settings["providers"][0]["apiKey"].as_str(),
            Some("sk-roundtrip")
        );
    }
}
