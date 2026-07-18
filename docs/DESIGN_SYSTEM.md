# Design System

The app's visual language is **shadcn/ui (new-york style) + Tailwind CSS v4 + Radix**, with the **indigo** base color and **no customization**. This is the single source of truth. `AGENTS.md` governs the rules; this document is the reference catalog and decision log.

- **Tokens:** `src/styles/globals.css` (indigo OKLCH, light `:root` + dark `.dark`)
- **Primitives:** `src/components/ui/*` (shadcn-generated)
- **Common composites:** `src/components/common/*` (generic, domain-free composites like `ConfirmDialog`, `ImageLightbox`)
- **Form wrappers:** `src/components/settings/FormControls.tsx` (`Field`, `FieldInput`, `FieldTextarea`, `FieldSelect`, `Segmented`)
- **Entry:** `src/main.tsx` imports `globals.css` once

## 1. Tokens (indigo, no customization)

All colours are OKLCH values resolved through Tailwind semantic classes. Do not hardcode hex/`rgb()` in components.

| Tailwind class | Token | Role |
|---|---|---|
| `bg-background` / `text-foreground` | `--background` / `--foreground` | App background / primary text |
| `bg-card` / `text-card-foreground` | `--card` / `--card-foreground` | Cards, panels, top bar |
| `bg-popover` / `text-popover-foreground` | `--popover` / `--popover-foreground` | Select/dropdown/menu surfaces |
| `bg-primary` / `text-primary-foreground` | `--primary` / `--primary-foreground` | Primary action, active state, brand |
| `bg-secondary` / `text-secondary-foreground` | `--secondary` / `--secondary-foreground` | Secondary surfaces/badges |
| `bg-muted` / `text-muted-foreground` | `--muted` / `--muted-foreground` | Recessed surfaces, secondary text |
| `bg-accent` / `text-accent-foreground` | `--accent` / `--accent-foreground` | Hover/active backgrounds |
| `bg-destructive` | `--destructive` | Destructive actions, errors |
| `border-border` | `--border` | Borders/dividers |
| `bg-input` / `ring-ring` | `--input` / `--ring` | Input fills, focus ring |

**Layout tokens:** `--radius: 0.625rem` (with `--radius-sm/md/lg/xl` derived), `--split-h: 220px` (upload panel height). Dark theme applies via the `.dark` class on `<html>`, toggled from `state.darkMode` — no JS theme branching.

**Fonts:** Tailwind's default `--font-sans` system stack only. No web fonts, no serif/display face (DM Sans + DM Serif Display were removed with the shadcn adoption).

## 2. Primitive catalog

### shadcn primitives (`src/components/ui/`)
`button`, `card`, `input`, `label`, `textarea`, `select`, `badge`, `separator`, `tabs`, `dialog`, `alert-dialog`, `sheet`, `scroll-area`, `dropdown-menu`, `tooltip`, `alert`, `checkbox`.

Key usage:
- **Button** — variants `default|secondary|outline|ghost|destructive|link`; sizes `xs|sm|default|lg|icon|icon-sm`. Prefer `size="sm"` in dense rows. The default height (`h-9`) is the single control standard.
- **Card** — `Card` + `CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter`. Use for any surface card.
- **Dialog** — centered modal (`ConfirmDialog`). Backdrop + Esc dismiss supported.
- **Sheet** — right-anchored slide-out (`LogsViewer`, `PromptPreviewSheet`).
- **Tabs** — settings tab strip (`SettingsScreen`).
- **Select** — Radix-powered dropdown (replaces native `<select>`; `onValueChange(value)` not an event).

### App form wrappers (`src/components/settings/FormControls.tsx`)
The single home for labeled form fields. **Reuse these wherever a form appears** so the form UI is identical across tabs.

- **`Field({ label, desc?, hint?, children })`** — generic labeled wrapper. `desc` renders above the control (a description); `hint` renders below (a derived value, e.g. the resolved endpoint).
- **`FieldInput({ label, value, onChange, placeholder?, type?, disabled?, hint?, desc? })`** — labeled `<Input>`.
- **`FieldTextarea({ label, value, onChange, rows?, readOnly?, hint?, desc? })`** — labeled `<Textarea>`.
- **`FieldSelect({ label, value, onChange, placeholder?, disabled?, hint?, desc? })` + `FieldSelectOption`** — labeled `<Select>`. Note `onChange` receives a **string** (`onValueChange`), not an event.
- **`Segmented({ options, value, onChange })`** — mutually-exclusive toggle (e.g. Yes/No, Open/Controlled).

### App composite components
- **`CardActions`** — per-card `[status][Delete][Discard][Save]` row. Gates Save/Discard on `dirty` (kept in-layout via `invisible`).
- **`PendingChangesBar`** — tab-level `[count][status][Discard all][Apply]` banner for structural changes.
- **`StatusIndicator` / `SaveStatus`** (`SaveActions.tsx`) — shared status dispatch (busy→spinner, ok→check, err→x). Domains map their state into `StatusKind`.

## 3. Adding / extending

- **New control needed:** `npx shadcn@latest add <name>` from `app/`. Only add when genuinely reused (YAGNI).
- **New variant of an existing control:** add it to the shadcn primitive's `cva` variants, not as an ad-hoc `className` override at a call site.
- **New layout pattern that repeats:** extract a small composite component (like `FieldInput`), not a utility-class layer. Do not add Tailwind plugin presets or a second design system.

## 4. Inline styles — the only sanctioned exceptions

(See `AGENTS.md` → Frontend Guidelines → Inline styles.) Inline `style={{}}` is allowed **only** for values computed at runtime:

1. dnd-kit drag `transform`/`transition`/`opacity` (CataloguingFieldsTab, ArtefactFileTab sortable rows).
2. Data-driven widths/percentages (e.g. confidence-bar fill `width: ai.pct`).
3. App root `zoom: state.zoom`.
4. Data-driven status-dot `background` (the `_ST` hex strings in `app/defaults.ts` — a runtime value that cannot reference a Tailwind class from JS).

Everything else is a Tailwind class or a shadcn primitive.

## 5. Look-alike decision log

Records where similar designs were evaluated during the shadcn migration and the decision taken. Keep appending here when a new similar-design question arises.

| Pattern | Decision | Reason |
|---|---|---|
| **Form fields across tabs** (Providers, Artefact File, Fields) | **Standardized** into `FieldInput`/`FieldTextarea`/`FieldSelect`/`Field` | The headline requirement: identical form UI wherever reused. One wrapper, no per-tab markup. |
| **Expandable card/row body** (ProviderCard, ArtefactColumnRow, SortableFieldRow, VocabTab editor) | **Standardized** to a `bg-muted/30` recessed flex column with `animate-in fade-in slide-in-from-top-1` | One visual vocabulary for every "click to expand" surface; the previous bespoke padding/gap drift is gone. |
| **Status indicators** (save status, connection status) | **Standardized** on `StatusIndicator` (`SaveActions.tsx`) | One icon/color dispatch; domains map their enum in. |
| **Empty states** | **Standardized** to plain muted centered text via Tailwind (`text-muted-foreground p-X text-center`) | No special class; the previous dashed-border vs plain drift collapsed to one treatment. |
| **Drop zones** (Upload, Vocab upload) | **Edge case — keep** the dashed border via `border-dashed` | They are interactive drop targets (onClick + drag handlers), distinct from list-empty states; the dashed border is a deliberate drop affordance. |
| **Settings tab strip** | **Standardized** on shadcn `Tabs` | Replaces the hand-rolled `.ui-tabs`; gains keyboard nav. |
| **Overlays** (ConfirmDialog, LogsViewer, PromptPreviewSheet) | **Standardized** on shadcn `Dialog`/`Sheet` (Radix) | Gains correct focus-trap, scroll-lock, Esc, and backdrop dismiss for free; one overlay vocabulary. |
| **Image lightbox** (ResultRow thumbnail → full-screen zoom) | **Standardized** on shadcn `Dialog` (overlay) + a custom `useImageZoom` hook + inline `transform` (no zoom library) | Overlay reuses the vocabulary (focus-trap/Esc/backdrop) via `Dialog`. Zoom/pan is owned as plain React state (`{scale, tx, ty}`) and applied via a single inline `transform` (the sanctioned runtime-computed exception, §4 #1 — dnd-kit precedent). A zoom library was tried and reverted: its reactive scale, centering lifecycle, and smoothing were all unreliable; owning the transform state directly is simpler and correct (KISS). Surround is `bg-background` (theme-aware); the floating toolbar is `bg-popover`. |
| **Component directory taxonomy** (`ui/` vs `common/` vs `main/` vs `settings/`) | **Standardized** on a four-tier split; `ui/` is shadcn-generated primitives **only** | The deciding question for any new component is "is this a shadcn primitive?" — not "is it reusable?". `ui/` is reserved for `npx shadcn add` output (stock or `cva`-extended), so the "is this vendor-owned?" signal stays clean. Hand-written composites that *wrap* shadcn primitives live elsewhere by domain coupling: `common/` for generic domain-free composites (`ConfirmDialog`, `ImageLightbox` — no `AppState` imports), `main/` for main-screen feature components, `settings/` for settings-screen components + `FormControls.tsx`. `ImageLightbox` lives in `common/` even though it has one consumer (`ResultRow`) — the rule is coupling, not current reuse count (YAGNI applies to *creating* abstractions, not to *placing* existing ones). Generic React hooks live in `src/hooks/`, never `components/`. |
| **ConfirmDialog = Dialog, not AlertDialog** | **Edge case — keep Dialog** | The original contract allowed backdrop-click dismissal; `AlertDialog` blocks that to force an explicit choice, which would change behavior. |
| **Status dot colour** (`_ST` in defaults.ts) | **Edge case — hex string in JS** | The dot's `background` is a runtime inline style; a Tailwind class can't be referenced from a plain JS string. Concrete hex matching the semantic status colours. |
| **Wordmark/titles** | **Standardized** to sans system stack | DM Serif Display removed per "only keep shadcn"; titles are now `font-semibold` sans. |
| **Monospace** (ids, paths, code) | **Removed** | Monospace was intentionally dropped — all text renders in the sans system stack. |
| **Per-row action button** (ResultRow Stop/Retry, plus the error/cancelled Retry) | **Standardized** on shadcn `Button variant="outline" size="xs"` with `icon + label`, nested in the row's clickable header via `e.stopPropagation()` | One control for every inline row action. Stop = `Ban` icon (matches UploadPanel's whole-run Cancel); Retry = `RotateCcw` icon. The two are mutually exclusive by row status: `processing` → Stop (transport-level cancel of the in-flight AI call); `done`/`error`/`cancelled` → Retry; `queued` → none (the run is about to process it, so a retry would double-call). Stop cancels only that row and the run continues to the rest; real errors stay fail-fast. |
| **Dark-mode primary lightness** (`--primary` in `.dark`) | **Edge case — lifted** | The shadcn indigo is identical across themes (`oklch(0.546 0.245 262.881)`), and that mid-tone is low-contrast when `--primary` is used as text on the dark card (controlled-vocab dropdown selections, chevrons, AI dot, confidence-bar fill, "Use typed"). `.dark` lifts primary to `oklch(0.62 0.24 262.881)` — same hue/chroma, brighter lightness — and `--ring`/`--sidebar-primary`/`--sidebar-ring` track it so accents don't drift. `:root` (light) is unchanged. Lift is bounded at 0.62 to keep `--primary-foreground` (near-white) legible on default Buttons; push higher only after re-checking button contrast. |

## 6. Testing Radix overlays (jsdom note)

Radix locks `pointer-events: none` on `<body>` while an overlay is open, which `@testing-library/user-event` correctly enforces. To test backdrop dismissal under jsdom, use `userEvent.setup({ pointerEventsCheck: 0 })` and click the overlay element directly (`document.querySelector('[data-slot="dialog-overlay"]')` / `'[data-slot="sheet-overlay"]'`). This skips only the jsdom pointer-events limitation, not the behavior under test.
