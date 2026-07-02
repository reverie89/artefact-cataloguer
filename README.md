# Artefact Cataloguer

[![License: GPL](https://img.shields.io/badge/license-%20%20GNU%20GPLv3%20-blue.svg)](LICENSE)
[![Node 26](https://img.shields.io/badge/Node-26-blue.svg)](https://nodejs.org)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-blue.svg)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-orange.svg)](https://www.rust-lang.org)

**Artefact Cataloguer** is a Tauri 2 desktop app for AI-assisted museum cataloguing — upload an artefact spreadsheet, extract embedded images, run each row through an OpenAI-compatible model for ranked catalogue-field suggestions, review, and export CSV.

![Artefact Cataloguer demo](./demo.gif)

---

## Features

- **AI-assisted field suggestions** — one multimodal call per row (image + row   data) returns ranked `{ value, confidence }` picks per catalogue field.
- **Confidence bars** — each suggestion is shown with a coloured confidence bar and percentage so reviewers can weight picks at a glance.
- **Controlled vocabularies** — bind one or more term lists (`.csv`/`.xlsx`/ `.xls`) to a field; AI output is constrained to allowed terms, with built-in defaults (Historical Periods, Condition Grades).
- **Embedded-image extraction** — `.xlsx` drawing anchors are mapped to media files and snapped to the nearest data row; images are served via the Tauri asset protocol.
- **Image lightbox** — full-screen viewer with zoom-in/out/reset and a live percentage readout (local `useImageZoom` hook).
- **Run lifecycle** — Pause / Resume / Cancel a batch; per-row Stop (transport-level cancel of the in-flight call — only that row stops, the run continues) and per-row Retry / Retry-all-failed; first error fail-fasts the batch.
- **Review-friendly results** — expandable rows with status dots, searchable field dropdowns, filter + search over results, drag-to-reorder vocab/field lists.
- **Multiple AI providers** — configure several providers, mark one active, and run a **Test Connection** per provider (fetches the model list).
- **Settings import/export** — round-trip the settings blob as a zod-validated JSON file.
- **Theme & zoom** — dark mode (default on) and zoom (0.7–1.5), both persisted.
- **CSV export** — export the done rows via the native save dialog, header from the configured field names.

---

## Quick Start

Pre-built binaries are on the [Releases page](https://github.com/reverie89/artefact-cataloguer/releases).
To run from source:

```bash
git clone https://github.com/reverie89/artefact-cataloguer.git
cd artefact-cataloguer
npm install
npm run tauri:dev     # full app (Rust backend + renderer + window); HMR
# npm run dev         # renderer-only iteration at http://localhost:1420 (no Rust window)
```

---

## How to Use

### Step 1: Upload an artefact spreadsheet

Drag-and-drop one or more `.xlsx` files (or use the file picker). Each file is validated against the configured required columns, with per-file status
(`validating` / `valid` / `invalid`) and missing-column errors surfaced inline. Embedded images are extracted automatically.

### Step 2: Configure an AI provider

An active provider is required before cataloguing — without one, parsing the spreadsheet is blocked with a clear prompt to add one. See **Configuring an AI provider** below.

### Step 3: Run and review

Click **Start** to run the active provider over every row. Results stream in live: each row shows ranked suggestions per field with confidence bars. For each field, accept an AI pick, choose from its controlled-vocabulary dropdown, or type a value manually. Use the image lightbox to inspect the artefact.

During a run, **Pause** / **Resume** / **Cancel** controls are available. A **processing** row offers **Stop** (cancels just that row's in-flight call — the
rest of the run continues); a **done**/**errored**/**cancelled** row offers **Retry**, and all failed rows can be retried at once via **Retry all failed**.

### Step 4: Export

Click **Export** to save the **done** rows as CSV via the native save dialog.
The header is built from the configured field names; each field emits its selected value (or the top AI pick if none was chosen).

### Configuring an AI provider

AI providers are configured **inside the app** under
**Settings → AI Provider**:

1. Open the app and go to **Settings → AI Provider**.
2. Add a provider with a **Base URL**, **API key**, and **Model**.
3. Each provider declares its API family — one of:
   - `openai` (the default; any OpenAI-compatible `/chat/completions` endpoint)
   - `anthropic` (the native Anthropic API — `x-api-key` auth, `/v1/messages`)
   - `gemini` (the Google Gemini API — `/v1beta/models/.../generateContent`)

   This drives both the auth scheme and the endpoint paths.
4. Mark one provider as **active** to route catalogue-field requests through it.

Providers are persisted to the plaintext settings store next to the binary via the Rust `load_state` / `save_state` commands (no `localStorage`). Cataloguing
requires a real uploaded spreadsheet and a live, active provider — there is no bundled demo data or fallback.

---

## Requirements

- **Node ≥ 26** (see `.nvmrc`)
- **Rust** toolchain via [rustup](https://rustup.rs)
- **Windows SDK / MSVC Build Tools** (the native TLS stack compiles C; run
  builds from an MSVC environment — see `scripts/`).
- Rust targets:
  ```sh
  rustup target add aarch64-pc-windows-msvc x86_64-pc-windows-msvc
  ```

---

## Development

| Command | Description |
|---|---|
| `npm run dev` | vite dev server — renderer only (http://localhost:1420) |
| `npm run tauri:dev` | tauri dev — full app (Rust + renderer + window), HMR |
| `npm run build` | `tsc -b && vite build` — renderer → `dist/` (compile only, no installer) |
| `npm test` | vitest unit tests (renderer) |
| `npm run test:watch` | vitest in watch mode |
| `npm run lint` | eslint (`eslint .`) |
| `npm run build:win-all` | NSIS installers — arm64 + x86_64 |
| `cargo test` *(from `src-tauri/`)* | Rust unit tests |

---

## Build (Windows installers — arm64 + x86_64)

```sh
# Both targets, MSVC env auto-loaded:
powershell -ExecutionPolicy Bypass -File scripts/build-windows.ps1

# Or one target:
powershell -File scripts/build-windows.ps1 -Arm64
powershell -File scripts/build-windows.ps1 -X64
```

`build:win-all` / `build:win-arm64` / `build:win-x64` are the underlying
per-target `tauri build` scripts the wrapper invokes. Output:

```
src-tauri/target/<triple>/release/bundle/nsis/Artefact Cataloguer_*-setup.exe
```

---

## Architecture

Two layers with a shared contract: a **Rust backend** (`src-tauri/`) and a **React renderer** (`src/`), connected by Tauri commands + events. AI calls run in Rust so API keys never reach the renderer and CORS is a non-issue.

```text
src/
  main.tsx / App.tsx   entry + root component
  app/                 types, schema, defaults, state (reducer), actions, drafts, styles
  components/          TopBar, MainScreen (UploadPanel, ResultsPanel, ResultRow),
                       ImageLightbox, LogsViewer, ConfirmDialog
    settings/          Fields, Vocab, AI Provider, Artefact File, About
    ui/                shadcn/ui primitives (button, dialog, select, sheet, …)
  hooks/               useDropZone, useImageZoom (local — no zoom library)
  lib/                 store.ts (Rust bridge), spreadsheet.ts (SheetJS),
                       images.ts (fflate zip+drawings), ai.ts, logs.ts, utils.ts
  styles/globals.css   indigo OKLCH tokens (Tailwind v4 @theme)
src-tauri/src/
  lib.rs               command registry + load_state / save_state
  settings.rs          settings.json persistence
  images.rs            write extracted image bytes, asset-protocol serving
  ai.rs                provider calls (openai / anthropic / gemini) via reqwest
```

- **XLSX parsing** uses SheetJS (`xlsx`) in the frontend; real column validation against configured required columns.
- **Image extraction** unpacks the `.xlsx` zip (`fflate`), maps `xl/drawings` anchors → `xl/media` files → data rows, then hands bytes to Rust to write beside the binary and serve via the asset protocol.
- **AI calls** run in Rust (`reqwest`, `rustls-tls`) against the configured provider's API (`openai`, `anthropic`, or `gemini`).

**Stack:** Tauri 2 (Rust backend + WebView2 frontend) · React 19 + TypeScript · shadcn/ui (new-york) + Tailwind CSS v4 + Radix · SheetJS (`xlsx`) · `fflate` · `zod` · `@dnd-kit` · `reqwest` + `tokio` + `serde` (Rust) · `lucide-react` icons.

**Runtime files:** settings live in `<exe_dir>/settings.json` (one blob: settings, dark-mode flag, zoom) read/written via the Rust `load_state` / `save_state` commands — no `tauri-plugin-store`, no `localStorage`. Extracted images unpack from the `.xlsx` zip into `<exe_dir>/tmp/artefact-cataloguer/<session>/…`; the whole subtree is wiped on app **start** and on app **quit**.

### Code conventions

The codebase follows **KISS · DRY · SOLID · YAGNI**. The full ruleset — including file-placement guidance, the shared-helper policy, design-token usage, the backend contract, and icon usage — lives in [`AGENTS.md`](AGENTS.md). Read it before contributing.

---

## License

This project is licensed under the GNU General Public License v3.0 (`GPL-3.0-only`). See [LICENSE](LICENSE).
