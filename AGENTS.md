# AGENTS.md

## Scope

These instructions apply to the entire repository.

## Project Context

Artefact Cataloguer is a Tauri 2 desktop app with a React + TypeScript frontend and a Rust backend.

- Frontend source lives in `src/`.
- Tauri/Rust source lives in `src-tauri/src/`.
- Generated output, dependencies, and build artifacts are not source: ignore `node_modules/`, `dist/`, `src-tauri/target/`, and lockfile-generated diffs unless the task explicitly targets them.

## Engineering Principles

Follow these principles for every code change:

- DRY: remove duplicated logic when it has the same reason to change. Do not create abstractions for coincidental similarity.
- KISS: prefer direct, readable implementations over clever or framework-heavy ones.
- SOLID: keep modules, hooks, components, reducers, and Rust modules focused on one responsibility.
- YAGNI: do not add features, options, compatibility layers, or abstractions unless required by the current task.
- Least privilege: keep Tauri capabilities, filesystem scope, CSP, and secret handling as narrow as practical.
- Type safety: avoid `unknown`, `any`, stringly typed field updates, and casts unless a boundary requires them. Validate untrusted JSON at runtime.
- Source of truth: avoid duplicating domain rules across frontend and Rust without a contract test or a clear owner.

## Planning Principle — Design In Totalality

Every implementation plan must account for the application's design system and plan the design **in totality** — tokens, primitives, and visual consistency across all affected surfaces — not in isolation per feature/tab/page. A change to one screen is a change to the shared visual language: reuse the existing shadcn primitives and Tailwind tokens rather than inventing a parallel version for the new surface.

When two surfaces look similar, **flag it for a decision** rather than silently diverging: standardize into one primitive/variant, or explicitly keep it as a named, documented edge case. Undocumented drift is the failure mode. Surface the decision (and the reason) in code comments and `docs/DESIGN_SYSTEM.md`'s decision log.

### UX Mockups

Any plan that changes visible layout or a user flow must include an ASCII wireframe of the proposed surface in the plan before implementation begins — show the new arrangement of controls, regions, and key states (e.g. empty/loading/error/selected) so the design intent is reviewable in totality, not reconstructed from prose.

Use box-drawing / plain-text mockups that render in the terminal and diff cleanly (no binary images, no external mockup links). Pure refactors of existing markup with no visible change, and token-only or copy-only tweaks, are exempt.

## Frontend Guidelines

- Use React function components and hooks consistent with the existing codebase.
- Keep hooks focused. Do not expand `useActions` or global state for unrelated concerns when a narrower hook, helper, or component is clearer.
- Keep reducer actions specific and typed. Avoid generic `{ key: string; value: unknown }` state mutations for domain data.
- Styling is Tailwind utility classes + shadcn primitives — no hand-written component CSS, no inline `style={{}}` except the sanctioned runtime values below.
- Keep async side effects at the edge. Put pure transformations in plain functions with tests.
- Do not update React state during render. Use controlled props or effects for synchronization.

### Inline styles

The only sanctioned inline `style={{}}` uses are values that are **computed at runtime** and cannot be a static class or token:

1. **dnd-kit drag transform/transition/opacity** on sortable rows (the drag library recomputes these each frame).
2. **Data-driven widths/percentages** (e.g. a confidence-bar fill at `ai.pct%`).
3. **App zoom** on the root container (`zoom: state.zoom`).
4. **One-off data-driven colours** applied to an element whose value comes from runtime data, not the token system (e.g. the status-dot `background` in `app/defaults.ts` `_ST`, which is a hex string because it cannot reference a Tailwind class from JS).

Anything else — a colour, radius, spacing, layout, or typography value — belongs in a Tailwind class or a shadcn primitive. A repeated inline value is a missing primitive: promote it into `components/ui/` or a `Field*` wrapper in `components/settings/FormControls.tsx` instead of copying it.

## Design Guidelines

The app's visual language is **shadcn/ui (new-york style) + Tailwind CSS v4 + Radix primitives**, with the **indigo** base color and **no customization**. This replaces the previous hand-written `theme.css`/`ui.css` token system entirely. The single source of truth for tokens and primitives is `src/styles/globals.css` (indigo OKLCH tokens) and `src/components/ui/` (shadcn primitives); see `docs/DESIGN_SYSTEM.md` for the full catalog and decision log.

Apply the engineering principles to visual decisions:

- **DRY**: every control lives once as a shadcn primitive in `src/components/ui/` and is composed, never rebuilt. A labeled form field is `FieldInput`/`FieldTextarea`/`FieldSelect`/`Field` in `components/settings/FormControls.tsx` — reuse these wherever a form appears (Providers, Artefact File, Fields tabs) so the form UI is identical wherever it's reused. Do not hand-roll `<label><input/></label>` markup inline.
- **KISS**: the stack is Tailwind utility classes + shadcn primitives, loaded once in `main.tsx` via `globals.css`. Use one control standard — the shadcn `Button` sizes (`sm`/`default`/`lg`/`icon`) — instead of overriding heights per use. Do not add a second component library, CSS-in-JS, or a hand-written CSS layer.
- **SOLID**: each shadcn primitive and its variants express one intent — `Button` variants (`default`/`secondary`/`outline`/`ghost`/`destructive`/`link`), `Badge` variants (`default`/`secondary`/`destructive`/`outline`). Do not overload a component with an unrelated job; pick the right primitive or variant.
- **YAGNI**: add a new shadcn primitive (`npx shadcn@latest add <name>`) only when it is genuinely reused, not for a single one-off. Do not introduce icon libraries beyond `lucide-react` or font families beyond the system stack.
- **Source of truth**: every colour is the indigo token resolved through `bg-primary`/`text-muted-foreground`/etc. — never a hand-written hex or `rgb()` in component code (the lone exception is the data-driven status-dot colour in `app/defaults.ts`, see Inline styles). Dark is the `:root` default; light overrides via the `.dark` class toggled on `<html>` from `state.darkMode` — do not branch on theme in JavaScript. Theme switching is automatic through the tokens.
- **Tokens**: the indigo OKLCH tokens (`--background`, `--foreground`, `--card`, `--primary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--radius`, etc.) live only in `src/styles/globals.css`, mapped to Tailwind via `@theme inline`. Do not redefine colours in component CSS.

### Fonts

The sanctioned font families are **Tailwind's default `--font-sans` system stack only** (the body face). DM Sans and DM Serif Display were intentionally removed with the shadcn adoption — do not reintroduce web fonts or a serif/display face. The wordmark and titles render in the sans system stack.

## Rust/Tauri Guidelines

- Treat the renderer as untrusted. Validate all paths, payloads, and IDs received by Tauri commands.
- Do not accept arbitrary absolute paths from the renderer when an opaque ID or server-side lookup can be used.
- Keep provider protocol serialization, HTTP transport, debug logging, prompt construction, and response parsing separable.
- Prefer explicit errors over silent fallback when AI responses, settings, or filesystem operations are invalid.
- Use `cargo fmt` and `cargo clippy` for Rust changes when available.

## Security Guidelines

- Never commit API keys, tokens, personal data, local settings, or generated temp images.
- Do not log raw API keys, authorization headers, image bytes, or full user files.
- Keep `src-tauri/capabilities/` permissions scoped to the app's actual needs.
- Keep CSP enabled and restrictive unless a task proves a specific exception is needed.
- Prefer OS keychain or encrypted storage for persisted secrets.

## Testing And Verification

Run the smallest relevant verification set before finishing a change:

- `npm run lint`
- `npm run test`
- `npm run build`
- `cargo fmt --manifest-path "src-tauri/Cargo.toml" --check`
- `cargo clippy --manifest-path "src-tauri/Cargo.toml" --all-targets --all-features -- -D warnings`
- `cargo test --manifest-path "src-tauri/Cargo.toml"`

If a command cannot run in the current environment, report the command and the reason.

## Documentation

- Keep README behavior claims aligned with code.
- Document why non-obvious decisions exist, not what each line does.
- Remove stale comments, demo references, unused helpers, and dead types when they are no longer justified.
