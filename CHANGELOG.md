# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-19

### Added

- Column-scoped search over cataloguing results — reviewers pick which artefact-file and catalogue columns a search matches.
- Multi-value selection for controlled-vocabulary fields — pick more than one term, joined with ` | ` on display/export.
- Per-column toggles "Include for AI" and "Include in Export" (Artefact File tab), independent of display.
- Embedding Providers settings section with its own connection test, alongside the existing vision/chat providers.
- Shared Expand all / Collapse all and Unsaved badge across the Cataloguing Fields, Vocabulary Lists, and Artefact File tabs.
- Optional vocabulary-validation step (toggleable) that picks verbatim from the candidate net.

### Changed

- Cataloguing now uses an embedding-backed vocabulary pipeline: vision extraction → per-field embedding search against synced LanceDB tables (fused by max cosine similarity) → optional validation backstop. Vocabulary suggestions now carry a cosine-grounded similarity score instead of a model-reported confidence.
- Model Providers tab split into Vision and Embedding sub-tabs; "Fields" renamed to "Cataloguing Fields".
- Export switched from CSV to `.xlsx` (via ExcelJS), now also used for reading the artefact file.
- User-facing copy renames "Call 1" / "Call 3" to "vision analysis" / "validation" in the About tab and README; pipeline documented as a mermaid diagram.
- README gains a system-overview diagram showing the renderer → IPC → Rust trust boundary and outbound egress paths.

### Security

- Provider API keys are now stored in the OS keychain (Windows Credential Manager / macOS Keychain / Linux secret service) and scrubbed from `settings.json`. Plaintext keys found in an older or shared `settings.json` are migrated to the keychain automatically on first load.
- Exported cells are sanitized against spreadsheet formula injection (OWASP guidance).

### Fixed

- Embedded image-to-row mapping on artefact-file sheets that contain blank rows.
- Vocab-source picker appearing stuck after a source was removed (now remounts to its placeholder); vocab-type fields with no source now show a "No source added" badge.

## [1.0.0] - 2026-07-04

### Added

- Initial release.

[1.0.0]: https://github.com/reverie89/artefact-cataloguer/releases/tag/v1.0.0
[1.1.0]: https://github.com/reverie89/artefact-cataloguer/releases/tag/v1.1.0
