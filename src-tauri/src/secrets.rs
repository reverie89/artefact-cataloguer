//! File-backed storage for provider API keys.
//!
//! Keys live in a dotenv-style `.env` file beside `settings.json` rather than
//! in the plaintext settings blob. The OS keychain was dropped because its
//! Linux backend (kernel keyutils) is session-scoped and silently loses keys
//! across reboots; a plain file behaves identically on every platform. This
//! module owns the only storage touchpoints; `settings.rs` calls [`scrub`] /
//! [`rehydrate`] on save/load and never touches the store directly.
//!
//! Entry ids are stable per-provider: `chat::{provider.id}` and
//! `embedding::{provider.id}`, mapped to uppercase env names (`CHAT__P1`).
//! The provider `id` is the existing stable React key (never empty), so
//! renaming a provider keeps its key. Deleting a provider leaves its line
//! behind (a harmless orphan); this module does not expose a forget hook.
//! The file is machine-managed and read once at startup: hand edits apply on
//! the next app start. Each entry carries a `# {provider name}` comment line
//! — the id keys the storage; the comment is what a human reads — kept in
//! sync with the provider's current name on every save.
//!
//! A swappable [`Store`] trait lets tests substitute an in-memory backend.
//! The production [`EnvFileStore`] consults the OS keychain once per missing
//! entry and migrates any hit into the `.env`, so installs from a pre-`.env`
//! release keep their keys without user action.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

/// A minimal secret store. Production writes the `.env` file; tests inject an
/// in-memory implementation.
pub trait Store: Send + Sync {
    /// Persist `secret` under `entry_id`. Returns `Err` only on a backend
    /// failure the caller may want to fall back from.
    fn set(&self, entry_id: &str, secret: &str) -> Result<(), String>;
    /// Persist with a human-readable label, rendered as the comment line
    /// above the entry. Backends without label support may ignore it.
    fn set_labeled(&self, entry_id: &str, secret: &str, label: &str) -> Result<(), String> {
        let _ = label;
        self.set(entry_id, secret)
    }
    /// Read `secret` for `entry_id`. `None` means "no entry" (first run, or a
    /// settings folder whose `.env` didn't come along). Backend errors are
    /// logged and treated as `None` so a storage failure never crashes a
    /// parse run.
    fn get(&self, entry_id: &str) -> Option<String>;
}

// ---------------------------------------------------------------------------
// Entry-id construction — stable per provider id.

/// Build the secret-store entry id for a chat/vision provider.
pub fn chat_entry_id(provider_id: &str) -> String {
    format!("chat::{provider_id}")
}

/// Build the secret-store entry id for an embedding provider.
pub fn embedding_entry_id(provider_id: &str) -> String {
    format!("embedding::{provider_id}")
}

// ---------------------------------------------------------------------------
// `.env` file format: `NAME="value"` lines, `#` comments, one secret per line.

/// Header written at the top of every `.env` file.
const ENV_HEADER: &str =
    "# artefact-cataloguer provider API keys — managed by the app; hand edits apply on restart.\n";

/// One stored secret: the value plus the human-readable label rendered as the
/// comment line above it. Labels are parsed back from hand-written comments
/// so a rewrite preserves them.
struct StoredSecret {
    value: String,
    label: Option<String>,
}

/// Flatten a label to a single comment line — provider names come from the
/// settings file and could hold anything. `None` = nothing worth writing.
fn comment_line(label: &str) -> Option<String> {
    let flat = label.replace(['\n', '\r'], " ").trim().to_string();
    if flat.is_empty() {
        None
    } else {
        Some(format!("# {flat}\n"))
    }
}

/// Map an entry id (`chat::p1`) to an env-file name (`CHAT__P1`). The mapping
/// is mechanical and injective — names are only ever looked up by
/// construction, never parsed back. An unrepresentable id is an error; with
/// app-generated ids this never fires.
fn env_name(entry_id: &str) -> Result<String, String> {
    let name = entry_id.replace("::", "__").to_ascii_uppercase();
    if !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        Ok(name)
    } else {
        Err(format!("entry id {entry_id:?} has no env-file name"))
    }
}

/// Escape a value for double-quoted output; [`unescape`] inverts exactly the
/// two sequences emitted here and keeps any other backslash verbatim.
fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Parse a value: double-quoted values are unescaped, anything else is taken
/// verbatim (hand-edited unquoted values stay readable).
fn parse_value(raw: &str) -> String {
    match raw.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
        Some(inner) if raw.len() >= 2 => unescape(inner),
        _ => raw.to_string(),
    }
}

/// Read the store file. A missing file is a normal first run (empty store);
/// malformed lines are skipped with a logged note rather than poisoning the
/// whole store. A comment line attaches as the label of the entry that
/// follows it (a blank line detaches it), so hand-written comments survive
/// rewrites. Values are never logged.
fn read_env_file(path: &Path) -> BTreeMap<String, StoredSecret> {
    let mut entries = BTreeMap::new();
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(_) => return entries,
    };
    let mut comment: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == ENV_HEADER.trim() {
            continue;
        }
        if trimmed.is_empty() {
            comment = None;
            continue;
        }
        if trimmed.starts_with('#') {
            comment = Some(trimmed.trim_start_matches('#').trim().to_string());
            continue;
        }
        let Some((name, value)) = trimmed.split_once('=') else {
            eprintln!("[artefact] ignoring malformed line in {}", path.display());
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            eprintln!("[artefact] ignoring malformed line in {}", path.display());
            continue;
        }
        entries.insert(
            name.to_string(),
            StoredSecret {
                value: parse_value(value.trim()),
                label: comment.take(),
            },
        );
    }
    entries
}

/// Rewrite the store file atomically (write `.env.tmp`, rename over the
/// target — `rename` replaces existing files on both Windows and Unix) and
/// owner-only on Unix. Windows inherits the profile-directory ACLs.
fn write_env_file(path: &Path, entries: &BTreeMap<String, StoredSecret>) -> Result<(), String> {
    let mut body = String::from(ENV_HEADER);
    for (name, secret) in entries {
        if let Some(comment) = secret.label.as_deref().and_then(comment_line) {
            body.push_str(&comment);
        }
        body.push_str(name);
        body.push_str("=\"");
        body.push_str(&escape(&secret.value));
        body.push_str("\"\n");
    }
    let mut tmp_name = path
        .file_name()
        .map(std::ffi::OsStr::to_os_string)
        .unwrap_or_default();
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);
    fs::write(&tmp, body).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp, path).map_err(|e| format!("committing {}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Production store (.env file) + legacy keychain fallback.

/// The `.env` file store. Entries are read once at construction and held in
/// memory; every `set` rewrites the whole file.
struct EnvFileStore {
    path: PathBuf,
    entries: Mutex<BTreeMap<String, StoredSecret>>,
    /// Pre-`.env` releases kept keys in the OS keychain; a miss here falls
    /// back to it and copies any hit into the file (one-time migration).
    legacy: Option<Box<dyn Store>>,
}

impl EnvFileStore {
    /// Production store: `.env` beside the running binary (i.e. beside
    /// `settings.json`), keychain as migration fallback.
    fn production() -> Self {
        Self::new(
            crate::settings::exe_dir().join(".env"),
            Some(Box::new(KeyringStore)),
        )
    }

    fn new(path: PathBuf, legacy: Option<Box<dyn Store>>) -> Self {
        Self {
            entries: Mutex::new(read_env_file(&path)),
            path,
            legacy,
        }
    }
}

impl Store for EnvFileStore {
    fn set(&self, entry_id: &str, secret: &str) -> Result<(), String> {
        let name = env_name(entry_id)?;
        let mut entries = self.entries.lock().unwrap();
        entries.insert(
            name,
            StoredSecret {
                value: secret.to_string(),
                label: None,
            },
        );
        write_env_file(&self.path, &entries)
    }

    fn set_labeled(&self, entry_id: &str, secret: &str, label: &str) -> Result<(), String> {
        let name = env_name(entry_id)?;
        let mut entries = self.entries.lock().unwrap();
        entries.insert(
            name,
            StoredSecret {
                value: secret.to_string(),
                label: Some(label.to_string()),
            },
        );
        write_env_file(&self.path, &entries)
    }

    fn get(&self, entry_id: &str) -> Option<String> {
        let name = match env_name(entry_id) {
            Ok(n) => n,
            Err(e) => {
                eprintln!("[artefact] secret lookup skipped: {e}");
                return None;
            }
        };
        if let Some(secret) = self.entries.lock().unwrap().get(&name) {
            return Some(secret.value.clone());
        }
        let value = self.legacy.as_ref()?.get(entry_id)?;
        // Migrate the keychain hit into the file; if the write fails, the key
        // still works for this run and the migration retries next start.
        if let Err(e) = self.set(entry_id, &value) {
            eprintln!("[artefact] could not migrate {entry_id} into the .env file: {e}");
        }
        Some(value)
    }
}

/// The keyring service name. Only consulted as the legacy migration fallback.
const SERVICE: &str = "artefact-cataloguer";

/// Legacy OS-keychain store (Windows Credential Manager / macOS Keychain /
/// Linux keyutils). Kept only so a pre-`.env` install's keys migrate on
/// first load; remove together with the `keyring` dependency once the
/// migration window closes.
struct KeyringStore;

/// True if a keyring error represents "no such entry" (the expected case).
/// Matched via the `Display` representation rather than
/// `keyring::Error::NoEntry` directly — the error enum's exact path/variant
/// has shifted across keyring versions, but its displayed text ("No matching
/// entry" / "No entry found" / similar) has stayed stable, and
/// string-matching degrades gracefully if the variant is renamed again.
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

/// The production store, lazily initialised.
static STORE: OnceLock<Box<dyn Store>> = OnceLock::new();

/// Test-only override slot. A `Mutex<Option<…>>` (not `OnceLock`) so each test
/// can install a fresh in-memory store and clear it on teardown — `OnceLock`
/// is one-shot and would leak state between tests in the same binary. Tests
/// never touch the real `.env` file.
#[cfg(test)]
static TEST_STORE: Mutex<Option<Box<dyn Store>>> = Mutex::new(None);

/// Acquire the active store for one call. Tests can substitute an in-memory
/// backend via [`set_store_for_tests`]; production uses the `.env` file. The
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
    f(STORE
        .get_or_init(|| Box::new(EnvFileStore::production()))
        .as_ref())
}

/// Test-only: substitute a store so tests don't touch the real `.env` file.
/// Each call replaces the previous store (so tests are isolated); pass `None`
/// to clear. Production code never calls this.
#[cfg(test)]
pub fn set_store_for_tests(store: Option<Box<dyn Store>>) {
    *TEST_STORE.lock().unwrap() = store;
}

/// Test-only: an env-file store rooted at an explicit directory, with the
/// standard legacy keychain fallback. The live probe targets the debug
/// build's settings directory, which differs from the test binary's exe dir.
#[cfg(test)]
pub fn store_for_dir(dir: &Path) -> Box<dyn Store> {
    Box::new(EnvFileStore::new(
        dir.join(".env"),
        Some(Box::new(KeyringStore)),
    ))
}

/// Persist a key with the provider's display name as its comment line. `Err`
/// signals a backend failure (caller falls back to plaintext to avoid losing
/// the key).
pub fn set_key_labeled(entry_id: &str, key: &str, label: &str) -> Result<(), String> {
    with_store(|s| s.set_labeled(entry_id, key, label))
}

/// Read a key. `None` = no entry / unreadable (degrade to "missing key").
pub fn get_key(entry_id: &str) -> Option<String> {
    with_store(|s| s.get(entry_id))
}

// ---------------------------------------------------------------------------
// settings.rs integration: scrub on save, rehydrate (+ migrate) on load.

/// Move every non-empty `apiKey` out of the in-memory settings blob into the
/// secret store, replacing each with `""` so the serialised `settings.json`
/// never holds a key in cleartext. On a store failure the key is left in
/// place (graceful degradation) rather than dropping it.
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
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let entry_id = entry_id(id);
        match set_key_labeled(&entry_id, key, name) {
            Ok(()) => {
                if let Some(obj) = entry.as_object_mut() {
                    obj.insert("apiKey".to_string(), Value::String(String::new()));
                }
            }
            Err(e) => {
                // Leave the key in the JSON so the app still works; the
                // plaintext-at-rest risk is accepted over losing the key.
                eprintln!("[artefact] secret write failed for {entry_id}: {e} — leaving key in settings.json");
            }
        }
    }
}

/// Reattach keys from the secret store to the in-memory settings blob. For
/// any provider whose stored entry is absent but whose persisted `apiKey` is
/// non-empty (an older save pre-secret-store, or a shared file), migrate it:
/// write it to the store now and scrub the in-memory copy so the next save
/// persists the scrub. Idempotent — a second load finds the stored entry and
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
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
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
                // One-time migration: move the plaintext key into the store
                // and scrub the in-memory copy.
                && set_key_labeled(&entry_id, &persisted, name).is_ok() =>
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
// Tests run against injected stores or temp files; the real `.env` and OS
// keychain are never touched.

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

        fn with_entry(entry_id: &str, secret: &str) -> Self {
            let mut map = HashMap::new();
            map.insert(entry_id.to_string(), secret.to_string());
            Self(Mutex::new(map))
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

    /// A unique temp path per test (tests run in threads of one process).
    fn temp_env_path(tag: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("ac-secrets-{}-{tag}.env", std::process::id()));
        let _ = fs::remove_file(&path);
        path
    }

    #[test]
    fn entry_ids_are_namespaced_and_stable() {
        assert_eq!(chat_entry_id("p1"), "chat::p1");
        assert_eq!(embedding_entry_id("p1"), "embedding::p1");
        assert_ne!(chat_entry_id("p1"), embedding_entry_id("p1"));
    }

    #[test]
    fn env_names_map_mechanically_and_reject_junk() {
        assert_eq!(env_name("chat::p1").unwrap(), "CHAT__P1");
        assert_eq!(
            env_name("embedding::_yretbxe").unwrap(),
            "EMBEDDING___YRETBXE"
        );
        assert!(env_name("chat::a b").is_err());
        assert!(env_name("").is_err());
    }

    #[test]
    fn set_get_round_trip() {
        let _g = install_memory_store();
        set_key_labeled("chat::p1", "sk-abc", "p1").unwrap();
        assert_eq!(get_key("chat::p1").as_deref(), Some("sk-abc"));
    }

    #[test]
    fn get_returns_none_for_missing_entry() {
        let _g = install_memory_store();
        assert!(get_key("chat::never").is_none());
    }

    #[test]
    fn scrub_moves_keys_out_of_settings_and_into_the_store() {
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
        // …and present in the store under the namespaced ids.
        assert_eq!(get_key("chat::p1").as_deref(), Some("sk-secret"));
        assert_eq!(get_key("embedding::e1").as_deref(), Some("emb-key"));
        // An empty key is not stored (no spurious entry).
        assert!(get_key("chat::p2").is_none());
    }

    #[test]
    fn rehydrate_reattaches_keys_from_the_store() {
        let _g = install_memory_store();
        set_key_labeled("chat::p1", "sk-restored", "p1").unwrap();
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
        // A pre-secret-store settings file: non-empty apiKey, no stored entry.
        let _g = install_memory_store();
        let mut settings = serde_json::json!({
            "providers": [ { "id": "p1", "apiKey": "sk-legacy" } ]
        });
        rehydrate(&mut settings);
        // Key moved into the store…
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
                                  // Second pass finds the stored entry, reattaches, no double-migration.
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

    #[test]
    fn env_file_round_trips_across_instances() {
        let path = temp_env_path("roundtrip");
        {
            let store = EnvFileStore::new(path.clone(), None);
            store.set("chat::p1", "sk-abc").unwrap();
        }
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("CHAT__P1=\"sk-abc\""), "raw file: {text}");
        let reloaded = EnvFileStore::new(path, None);
        assert_eq!(reloaded.get("chat::p1").as_deref(), Some("sk-abc"));
    }

    #[test]
    fn env_file_escapes_quotes_backslashes_and_equals() {
        let path = temp_env_path("escape");
        let tricky = "a\"b\\c=d#e";
        {
            let store = EnvFileStore::new(path.clone(), None);
            store.set("embedding::e1", tricky).unwrap();
        }
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("EMBEDDING__E1=\"a\\\"b\\\\c=d#e\""),
            "raw file: {text}"
        );
        let reloaded = EnvFileStore::new(path, None);
        assert_eq!(reloaded.get("embedding::e1").as_deref(), Some(tricky));
    }

    #[test]
    fn env_file_missing_file_reads_empty_and_set_creates_it() {
        let path = temp_env_path("missing");
        let store = EnvFileStore::new(path.clone(), None);
        assert_eq!(store.get("chat::p1"), None);
        store.set("chat::p1", "sk-new").unwrap();
        assert!(path.exists());
    }

    #[test]
    fn env_file_skips_malformed_lines_and_comments() {
        let path = temp_env_path("malformed");
        fs::write(
            &path,
            "# artefact header\n\nGARBAGE LINE WITHOUT EQUALS\nCHAT__P1=\"sk-ok\"\n",
        )
        .unwrap();
        let store = EnvFileStore::new(path, None);
        assert_eq!(store.get("chat::p1").as_deref(), Some("sk-ok"));
        assert_eq!(store.get("chat::absent"), None);
    }

    #[test]
    fn env_file_reads_unquoted_hand_edits() {
        let path = temp_env_path("unquoted");
        fs::write(&path, "CHAT__P1=sk-bare\n").unwrap();
        let store = EnvFileStore::new(path, None);
        assert_eq!(store.get("chat::p1").as_deref(), Some("sk-bare"));
    }

    #[test]
    fn env_file_migrates_a_legacy_keychain_entry() {
        let path = temp_env_path("legacy");
        let store = EnvFileStore::new(
            path.clone(),
            Some(Box::new(MemoryStore::with_entry("chat::p1", "sk-old"))),
        );
        assert_eq!(store.get("chat::p1").as_deref(), Some("sk-old"));
        // The hit was persisted into the file…
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("CHAT__P1=\"sk-old\""));
        // …so a fresh instance reads it without the legacy store.
        let reloaded = EnvFileStore::new(path, None);
        assert_eq!(reloaded.get("chat::p1").as_deref(), Some("sk-old"));
    }

    #[cfg(unix)]
    #[test]
    fn env_file_is_owner_only_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_env_path("perms");
        let store = EnvFileStore::new(path.clone(), None);
        store.set("chat::p1", "sk-abc").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn env_file_comment_carries_the_provider_name() {
        let path = temp_env_path("comment");
        {
            let store = EnvFileStore::new(path.clone(), None);
            store
                .set_labeled("chat::p1", "sk-abc", "GLM-5.3-Flash")
                .unwrap();
        }
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("# GLM-5.3-Flash\nCHAT__P1=\"sk-abc\""),
            "raw file: {text}"
        );
        // A reload re-attaches the comment, so a later rewrite (even of an
        // unrelated entry) keeps it.
        let reloaded = EnvFileStore::new(path.clone(), None);
        reloaded.set("embedding::e1", "emb-key").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# GLM-5.3-Flash"), "comment lost: {text}");
    }

    #[test]
    fn env_file_comment_updates_on_rename() {
        let path = temp_env_path("rename");
        let store = EnvFileStore::new(path.clone(), None);
        store.set_labeled("chat::p1", "sk-abc", "Old Name").unwrap();
        store.set_labeled("chat::p1", "sk-abc", "New Name").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("# New Name"), "raw file: {text}");
        assert!(!text.contains("Old Name"));
    }

    #[test]
    fn env_file_comment_labels_flatten_to_one_line() {
        let path = temp_env_path("multiname");
        let store = EnvFileStore::new(path.clone(), None);
        store
            .set_labeled("chat::p1", "sk-abc", "Two\nLine\nName")
            .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("# Two Line Name\nCHAT__P1=\"sk-abc\""),
            "raw file: {text}"
        );
    }

    #[test]
    fn scrub_writes_provider_name_comments() {
        let _g = install_memory_store();
        let path = temp_env_path("scrublabels");
        set_store_for_tests(Some(Box::new(EnvFileStore::new(path.clone(), None))));
        let mut settings = serde_json::json!({
            "providers": [
                { "id": "p1", "name": "GLM-5.3-Flash", "apiKey": "sk-secret" },
                { "id": "p2", "name": "Keyless", "apiKey": "" }
            ]
        });
        scrub(&mut settings);
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("# GLM-5.3-Flash\nCHAT__P1=\"sk-secret\""),
            "raw file: {text}"
        );
        // The keyless provider never reaches the file at all.
        assert!(!text.contains("Keyless"));
        set_store_for_tests(None);
    }
}
