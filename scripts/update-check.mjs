// Pre-build / pre-dev dependency update check + smart updater.
//
// Two modes:
//   node scripts/update-check.mjs           (default) — report only
//   node scripts/update-check.mjs --update            — apply safe updates
//   npm run update:deps                               — convenience alias
//
// REPORT mode (the `predev`/`prebuild` hooks) warns (never blocks) when
// npm-managed deps are behind their latest versions, and always exits 0 so
// `npm run dev` / `npm run build` can't be broken by a network blip or a
// stale version.
//
// UPDATE mode (`--update`) applies only SAFE, semver-respecting bumps:
//   • npm deps:   in-range bumps to `wanted` via `npm update <pkgs>`
//                 (your caret ranges in package.json are left untouched).
// Major/range-breaking bumps are NEVER auto-applied; they're listed with the
// exact command to run yourself. If the registry is unreachable, the update
// is skipped with a warning (still exit 0).
//
// Dependency-free: uses only Node built-ins (child_process).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Timeout for the lightweight version probe (`npm outdated`).
const TIMEOUT_MS = 5000;
// Generous timeout for `npm update`, which hits the network and may fetch
// multiple tarballs. Independent of TIMEOUT_MS above.
const APPLY_TIMEOUT_MS = 180_000;

// --- argv -----------------------------------------------------------------
const ARGS = new Set(process.argv.slice(2));
const UPDATE = ARGS.has("--update");
if (ARGS.has("--help") || ARGS.has("-h")) {
  console.log(`update-check.mjs — dependency update check + smart updater

Usage:
  node scripts/update-check.mjs            Report outdated deps (default)
  node scripts/update-check.mjs --update   Apply safe (semver) updates
  npm run update:deps                      Convenience alias for --update
`);
  process.exit(0);
}

// --- ANSI -----------------------------------------------------------------
// Disable colors when not a TTY or in CI so piped/CI output stays plain.
const color =
  process.stdout.isTTY && !process.env.CI && !process.env.GITHUB_ACTIONS
    ? {
        dim: (s) => `\x1b[2m${s}\x1b[0m`,
        yellow: (s) => `\x1b[33m${s}\x1b[0m`,
        red: (s) => `\x1b[31m${s}\x1b[0m`,
        cyan: (s) => `\x1b[36m${s}\x1b[0m`,
        bold: (s) => `\x1b[1m${s}\x1b[0m`,
      }
    : { dim: (s) => s, yellow: (s) => s, red: (s) => s, cyan: (s) => s, bold: (s) => s };

// --- npm-managed deps via `npm outdated --json` ---------------------------
// Returns { pkg: { current, wanted, latest } } for every outdated package.
function checkNpmDeps() {
  // shell: true so the `npm` (or `npm.cmd`) shim resolves cross-platform.
  const res = spawnSync("npm outdated --json", {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
    shell: true,
  });
  // `npm outdated` exits non-zero when deps are outdated — that's normal and
  // the JSON is still on stdout. Only treat missing stdout as an error.
  const out = res.stdout ?? "";
  if (!out && res.error) throw res.error;
  const parsed = JSON.parse(out || "{}");
  const entries = Object.entries(parsed).filter(
    ([, v]) => v && v.current && v.latest && v.current !== v.latest
  );
  return entries.map(([name, v]) => ({
    name,
    current: v.current,
    wanted: v.wanted || v.current,
    latest: v.latest,
  }));
}

// --- Safe-update planning & application (--update mode) -------------------
// Split outdated npm deps into in-range bumps (auto-applied) and range-breaking
// bumps (majors → manual review). `wanted` is the highest version the existing
// caret range allows; `latest` is the absolute newest.
function planNpmUpdates(outdated) {
  const apply = [];
  const review = [];
  for (const d of outdated) {
    if (d.wanted !== d.current) apply.push(d);
    if (d.wanted !== d.latest) review.push(d);
  }
  return { apply, review };
}

// Run `npm update <pkgs...>`: bumps resolved versions within their ranges and
// refreshes package-lock.json. Caret ranges in package.json are untouched.
function applyNpmUpdates(pkgs) {
  const names = pkgs.map((p) => p.name);
  const res = spawnSync(`npm update ${names.join(" ")}`, {
    cwd: ROOT,
    stdio: "inherit",
    timeout: APPLY_TIMEOUT_MS,
    shell: true,
  });
  if (res.status !== 0) {
    throw new Error(`npm update exited ${res.status}`);
  }
}

// --- Output ---------------------------------------------------------------
function printBox(lines) {
  const inner = Math.max(...lines.map((l) => stripAnsi(l).length), 20);
  const top = color.cyan(`┌ update-check ${"─".repeat(inner - 13)}`);
  const bot = color.cyan(`└${"─".repeat(inner + 2)}┘`);
  console.log(top);
  for (const l of lines) console.log(`${color.cyan("│")} ${l}`);
  console.log(bot);
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex -- stripping ANSI codes requires the ESC control char.
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// --- Main -----------------------------------------------------------------
function probe() {
  try {
    return { npmOutdated: checkNpmDeps(), npmErr: null };
  } catch (e) {
    return { npmOutdated: null, npmErr: e };
  }
}

// Default (no-flag) mode: non-mutating warning, printed in a box when anything
// is outdated or a single quiet line when everything is current.
function runReport({ npmOutdated, npmErr }) {
  if (npmErr) {
    // Network/registry down: fail open but loud.
    console.log(
      color.red(
        `[update-check] WARNING: could not reach registry — update check skipped. (${shortErr(npmErr)})`
      )
    );
    return;
  }

  if (npmOutdated.length === 0) {
    // Quiet single line when fully current.
    console.log(`${color.dim("[update-check] all dependencies up to date")}`);
    return;
  }

  const lines = [
    color.yellow(`npm deps: ${npmOutdated.length} outdated`),
    ...npmOutdated.map(
      (d) => `   ${color.dim("•")} ${pad(d.name, 22)} ${d.current} ${color.dim("→")} ${color.yellow(d.latest)}`
    ),
    color.dim("  Apply safe updates with `npm run update:deps`, or run `npm outdated` and bump manually."),
  ];
  printBox(lines);
}

// `--update` mode: apply safe semver bumps, then list majors for manual review.
function runUpdate({ npmOutdated, npmErr }) {
  if (npmErr) {
    console.log(
      color.red(
        `[update-check] WARNING: could not reach registry — update skipped. (${shortErr(npmErr)})`
      )
    );
    return;
  }

  console.log(color.bold("update-check — applying safe updates\n"));
  const applied = [];
  const review = [];

  // In-range bumps via `npm update`.
  const { apply, review: majors } = planNpmUpdates(npmOutdated);
  for (const d of apply) applied.push(`${d.name} ${d.current} → ${d.wanted}`);
  review.push(...majors);
  if (apply.length > 0) {
    try {
      applyNpmUpdates(apply);
    } catch (e) {
      console.log(color.red(`  npm update failed (${shortErr(e)}) — skipped`));
      // Drop anything we failed to apply so the summary stays accurate.
      applied.length = applied.length - apply.length;
    }
  }

  // --- Results ------------------------------------------------------------
  for (const line of applied) {
    console.log(`  ${color.cyan("✓ applied")} ${line}`);
  }
  if (review.length > 0) {
    console.log(`\n  ${color.yellow("manual review (majors / range-breaking):")}`);
    for (const d of review) {
      console.log(
        `   ${color.dim("•")} ${pad(d.name, 22)} ${d.current} ${color.dim("→")} ${color.yellow(d.latest)}  ${color.dim(`npm install ${d.name}@latest`)}`
      );
    }
  }

  const nReview = review.length;
  console.log(
    color.bold(
      `\n  Done: ${applied.length} safe bump(s) applied` +
        (nReview > 0 ? `; ${nReview} need manual review` : "") +
        "."
    )
  );
}

function main() {
  const state = probe();
  if (UPDATE) runUpdate(state);
  else runReport(state);
}

function pad(s, n) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function shortErr(e) {
  const m = (e && (e.message || String(e))) || "unknown error";
  return m.split("\n")[0].slice(0, 120);
}

try {
  main();
} catch (e) {
  // Genuine internal bug — loud, but still non-blocking (exit 0).
  console.error(color.red(`[update-check] internal error: ${shortErr(e)}`));
}
// Never throw: process always exits 0 (run as a pre* hook).
process.exitCode = 0;
