# AGENTS.md — artefact-cataloguer build rules for AI coding agents

This file is the entry point for any agent working in this repo. Read it
before planning or editing. Two references are equally binding: the design
system's deep rules (token catalog, primitive inventory, decision log) live in
[`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) — read it before any
UI-facing change — and the pipeline's shape lives in the "Cataloguing
pipeline" mermaid diagram in [`README.md`](README.md). This file keeps only
what always applies.

## What this project is

**Artefact Cataloguer** is a single-user desktop app for AI-assisted museum
cataloguing. A museum spreadsheet (.xlsx) is imported and parsed into
artefact rows with their embedded images; each row is catalogued field by
field through a three-step pipeline — prep, AI artefact analysis (the row's
image plus its configured columns, under a fixed XML request/reply contract),
then vocabulary matching against the app's synced vocab sources via
embeddings, with per-field distinct components and near-duplicate gating —
and the results are exported back to .xlsx in the museum's layout.

The renderer is untrusted. The Rust side owns the filesystem, secrets, the
vector store and all provider HTTP; the frontend reaches them only through
Tauri commands and never touches the network itself.

## Commands

```bash
npm run tauri:dev      # the desktop app in dev (vite + Rust)
npm run dev            # frontend only, in the browser
npm run test           # vitest run
npm run build          # tsc -b && vite build
npm run build:win-all  # release bundles: Windows installers (arm64 + x64)
npm run build:linux    # release bundle: AppImage

cargo fmt    --manifest-path "src-tauri/Cargo.toml" --check
cargo clippy --manifest-path "src-tauri/Cargo.toml" --all-targets --all-features -- -D warnings
cargo test   --manifest-path "src-tauri/Cargo.toml"
```

The host needs Node ≥ 26 and a Rust toolchain. Generated output, dependencies
and build artifacts (`node_modules/`, `dist/`, `src-tauri/target/`, and
lockfile-generated diffs) are not source — ignore them unless the task
explicitly targets them.

## Tech stack (locked — do not change without asking)

| Layer       | Choice                                          | Notes                                                                              |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Desktop     | **Tauri 2** (Rust 2021)                         | Renderer untrusted; capabilities and CSP kept narrow                               |
| Frontend    | **React 19 + TypeScript**                       | Function components + hooks; two screens (main, settings), no router               |
| Styling     | **Tailwind v4 + shadcn/ui**                     | New-york style, indigo base, no customization; tokens only in `src/styles/globals.css` |
| Icons       | **lucide-react**                                | Only icon source                                                                    |
| Drag & drop | **dnd-kit**                                     | Sortable card-list rows in settings                                                 |
| Spreadsheets| **exceljs + fflate** (frontend) · **calamine** (Rust) | Import/export stay in the museum's .xlsx layout                               |
| Validation  | **zod**                                         | Untrusted JSON validated at runtime boundaries                                      |
| Vector store| **LanceDB**                                     | Local `vocab_db`; embeddings for vocab matching                                     |
| Secrets     | **.env file**                                   | Beside settings.json; keyring 3 kept only to migrate pre-.env keys                  |
| HTTP        | **reqwest** (rustls)                            | Rust-side only; provider egress is the app's only outbound path                     |
| Tests       | **vitest + testing-library** / **cargo test**   | Colocated `*.test.ts(x)` beside their modules                                       |

## Module conventions

- Keep file boundaries; do not merge files. Keep files small enough to read at
  a glance — when a component or module passes roughly 300 lines, split along
  the established seams. Single-authority modules (`src/lib/store.ts`,
  `src/app/state.ts`) and test modules are exempt — one file by design.
- Components live in exactly one of four tiers by domain coupling:
  `components/ui/` = shadcn primitives only (stock or `cva`-extended);
  `components/common/` = generic, domain-free composites (`ConfirmDialog`,
  `ImageLightbox` — no `AppState`/domain imports); `components/main/` =
  main-screen feature components; `components/settings/` = settings-screen
  components + `FormControls.tsx`. Generic React hooks live in `src/hooks/`,
  never `components/`.
- `src/app/` is the state domain: the reducer (`state.ts`), actions, schema,
  drafts, defaults. Reducer actions are specific and typed — no generic
  `{ key: string; value: unknown }` mutations for domain data. Keep hooks
  focused: do not expand `useActions` or global state for unrelated concerns
  when a narrower hook, helper, or component is clearer.
- Keep async side effects at the edge; put pure transformations in plain
  functions with tests (in `src/lib/` or beside their module).
- Rust: keep provider protocol serialization, HTTP transport, debug logging,
  prompt construction, and response parsing separable (the `ai/` and
  `embeddings/` modules); one responsibility per module. Prefer explicit
  errors over silent fallback when AI responses, settings, or filesystem
  operations are invalid.

## Documentation style (enforce)

- Comments and docstrings state the rule, not the history. No anecdotes, no
  extraction archaeology. If why a rule exists matters, say it in one clause.
- One canonical home per explanation. Where a rationale already lives
  (`docs/DESIGN_SYSTEM.md` for tokens and primitives, `README.md` for the
  pipeline), reference it — never restate it in a second docstring.
- Module docstrings are a few lines; worked examples belong in tests, not
  prose. Document why non-obvious decisions exist, not what each line does.
- Keep README behavior claims aligned with code. Remove stale comments, demo
  references, unused helpers, and dead types when they are no longer justified.
- These rules apply to these docs too — this file and `docs/DESIGN_SYSTEM.md`
  alike: tighten instead of adding narrative, and cross-reference a section
  instead of restating it.

## Folder & file naming (enforce)

```
src/app/                  the state domain: state, actions, schema, drafts, defaults (+ tests)
src/components/ui/        shadcn primitives — stock or cva-extended only
src/components/common/    domain-free composites (ConfirmDialog, ImageLightbox)
src/components/main/      main-screen features (UploadPanel, ResultsPanel, TopBar, LogsViewer)
src/components/settings/  settings-screen components + FormControls.tsx (the Field* wrappers)
src/hooks/                generic React hooks (useConfirmDelete, useDropZone, useImageZoom…)
src/lib/                  pure helpers: ai, imageMeta, images, logs, spreadsheet, store, vocab, utils
src/styles/               globals.css — the only token definitions
src-tauri/src/            Tauri commands and Rust domain: settings, secrets, paths, images, vocab_files, ai/, embeddings/
```

- **Components are PascalCase** (`UploadPanel.tsx`); hooks are camelCase
  (`useDropZone.ts`); utility modules are camelCase (`imageMeta.ts`).
- **Named exports only.** The one exception is `App.tsx`'s default export,
  which mounts the tree.
- A component goes in `components/ui/` only if it is a genuinely generic
  control; anything that knows about artefacts, providers or vocab belongs to
  its feature tier.
- Field defaults and statuses live once in `src/app/defaults.ts`. When a
  domain rule would exist in both TypeScript and Rust, one side owns it —
  never duplicate without a contract test or a clear owner.

## Design rules (enforce)

The visual language is **shadcn/ui (new-york style) + Tailwind CSS v4 + Radix
primitives**, with the **indigo** base color and **no customization**.
`src/styles/globals.css` (indigo OKLCH tokens, mapped to Tailwind via
`@theme inline`) and `src/components/ui/` are the single sources of truth;
`docs/DESIGN_SYSTEM.md` is the full catalog and decision log.

- **No hardcoded colour.** Every colour is an indigo token resolved through
  `bg-primary`/`text-muted-foreground`/etc. — never a hand-written hex or
  `rgb()` in component code. The lone exception is the data-driven status-dot
  colour in `app/defaults.ts` (`_ST`), a hex string because it cannot
  reference a Tailwind class from JS. Do not redefine colours in component
  CSS.
- **Dark is the `:root` default;** light overrides via the `.dark` class
  toggled on `<html>` from `state.darkMode`. Never branch on theme in
  JavaScript — theme switching is automatic through the tokens.
- **Fonts:** Tailwind's default `--font-sans` system stack only — body face,
  wordmark and titles. Do not introduce web fonts, a serif/display face, or
  icon libraries beyond `lucide-react`.
- **One control standard.** shadcn `Button` sizes (`sm`/`default`/`lg`/`icon`)
  — no per-use height overrides. Each primitive and its variants express one
  intent (`Button`: default/secondary/outline/ghost/destructive/link;
  `Badge`: default/secondary/destructive/outline); pick the right primitive or
  variant instead of overloading a component with an unrelated job. Styling is
  loaded once in `main.tsx` via `globals.css`; no second component library, no
  CSS-in-JS, no hand-written CSS layer.
- **Every labeled form field is `FieldInput`/`FieldTextarea`/`FieldSelect`/
  `Field`** from `components/settings/FormControls.tsx` — never hand-rolled
  `<label><input/></label>` markup inline. The form UI is identical wherever
  it appears (Providers, Artefact File, Fields tabs).
- **Inline `style={{}}` is sanctioned only for values computed at runtime**
  that cannot be a static class or token:
  1. **dnd-kit drag transform/transition/opacity** on sortable rows (the drag
     library recomputes these each frame).
  2. **Data-driven widths/percentages** (e.g. a confidence-bar fill at
     `ai.pct%`).
  3. **App zoom** on the root container (`zoom: state.zoom`).
  4. **One-off data-driven colours** applied to an element whose value comes
     from runtime data, not the token system.

  Anything else — a colour, radius, spacing, layout, or typography value —
  belongs in a Tailwind class or a shadcn primitive. A repeated inline value
  is a missing primitive: promote it into `components/ui/` or a `Field*`
  wrapper instead of copying it.
- **Icon-only controls state their action on hover** (`title`, the `TopBar`
  idiom); the wording names the effect. A control whose visible text already
  states its action gets no tooltip.
- **No mock data.** Every value rendered is real data or an explicit empty
  state.
- **Do not update React state during render.** Use controlled props or
  effects for synchronization.
- **YAGNI on primitives:** add a new shadcn primitive
  (`npx shadcn@latest add <name>`) only when it is genuinely reused, not for a
  single one-off.
- **Similar surfaces converge.** When two surfaces look similar, flag it for a
  decision rather than silently diverging: standardize into one
  primitive/variant, or explicitly keep it as a named, documented edge case in
  `docs/DESIGN_SYSTEM.md`'s decision log. Undocumented drift is the failure
  mode.

## Security & renderer trust (enforce)

- Treat the renderer as untrusted. Validate all paths, payloads, and IDs
  received by Tauri commands; do not accept arbitrary absolute paths from the
  renderer when an opaque ID or lookup can be used.
- Keep `src-tauri/capabilities/` permissions, filesystem scope, CSP, and
  secret handling as narrow as practical. Keep CSP enabled and restrictive
  unless a task proves a specific exception is needed.
- Secrets live in the `.env` file beside settings.json — never in
  settings.json, never in code, never committed. Never commit API keys,
  tokens, personal data, local settings, or generated temp images. Do not log
  raw API keys, authorization headers, image bytes, or full user files.

## Fix suggestions must be validated, not guessed

Any fix, root cause, or solution you propose must be grounded in evidence from
the actual code. Read before claiming; verify behavior, not just existence;
run (`npm run test`, `cargo test`) when feasible; flag assumptions as
unverified; no "should"-as-fact. The AI provider path has behaved differently
from the obvious expectation more than once — probe it against a live
provider rather than reasoning from what the protocol would do.

## Duplication & shared-logic checks (enforce)

At planning time, before implementing, and again before declaring a task
done, look for logic that already exists in a form close enough to reuse.
Flag what you find; don't silently rewrite unrelated code as a side effect.

**Every plan must state a reuse assessment before approval is requested**:
name the existing components, hooks, helpers, and modules the work builds on,
and justify each new piece against them. When the same logic appears twice
with the same reason to change, propose extracting a shared module rather than
copying a variant. DRY, KISS, SOLID, YAGNI, least privilege, type safety and
source of truth are the standing criteria — one implementation per rule, one
reason to change per module, one authority per answer. Avoid `unknown`, `any`,
stringly typed field updates, and casts unless a boundary requires them;
validate untrusted JSON at runtime.

**Two code paths computing "the same answer" differently is the
highest-priority case, because divergence is a correctness bug, not a style
issue.** The authorities today:

- **The pipeline's shape** — the mermaid diagram under "Cataloguing pipeline"
  in `README.md`.
- **Design tokens and primitives** — `src/styles/globals.css` and
  `src/components/ui/`, catalogued in `docs/DESIGN_SYSTEM.md`.
- **Field defaults and statuses** — `src/app/defaults.ts`.

Extracting shared logic across features is a product decision — propose it
before doing it. Reusing an existing helper within a task's scope needs no
sign-off.

**Plans are design-in-totality.** Every plan accounts for the design system
across all affected surfaces — tokens, primitives, visual consistency — not
in isolation per feature/tab/page; a change to one screen is a change to the
shared visual language. Any plan that changes visible layout or a user flow
must also include an ASCII wireframe (box-drawing, renders in the terminal,
diffs cleanly — no binary images, no external mockup links) showing the new
arrangement of controls, regions, and key states (e.g. empty/loading/error/
selected), plus a plain-language explanation for a non-technical reader. Pure
refactors of existing markup with no visible change, and token-only or
copy-only tweaks, are exempt.

**Any plan that changes the pipeline** — adding/removing/reordering a stage,
flipping a step between optional and required, changing a gate condition,
renaming a settings key that appears in the diagram, or altering what reaches
the model — must include the corrected mermaid block from `README.md` as an
explicit plan step, so the change is reviewable in totality. Pure refactors
with no pipeline-shape change (renaming an internal function, adjusting an
HTTP timeout, tightening error messages) are exempt.

## Verification loop (before declaring a task done)

Run the smallest relevant verification set for the change:

1. `npm run test` — vitest suite passes.
2. `npm run build` — `tsc -b && vite build` clean.
3. For Rust changes: `cargo fmt --manifest-path "src-tauri/Cargo.toml" --check`, `cargo clippy --manifest-path "src-tauri/Cargo.toml" --all-targets --all-features -- -D warnings`, and `cargo test --manifest-path "src-tauri/Cargo.toml"`.
4. Manual pass in `npm run tauri:dev` on the flow you touched — upload →
   catalogue → export on the main screen, or the settings tab — in both
   themes.
5. Self-review against DRY, SOLID, SSOT, KISS and YAGNI (see "Duplication &
   shared-logic checks"): confirm no mock data, no hardcoded colours, no
   hand-rolled form fields, no unwired controls.
6. Git: never commit on your own. After the loop passes, ask the user for
   permission to commit, and only commit (with a Conventional Commits message)
   when they approve. A commit message is `type(scope): subject` — lowercase,
   imperative, no trailing period. Scope is the localized area (`settings`,
   `export`, `providers`…), omitted when the change spans the app. Add a short
   body only when the why isn't obvious from the subject. Never add
   attribution trailers (e.g. `Co-Authored-By:`). If the user commits
   themselves, do not amend or rewrite their history unless asked.

If a command cannot run in the current environment, report the command and
the reason.
