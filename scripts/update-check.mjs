// Pre-build / pre-dev dependency update check + smart updater.
//
// Two modes:
//   node scripts/update-check.mjs           (default) — report only
//   node scripts/update-check.mjs --update            — apply safe updates
//   npm run update:deps                               — convenience alias
//
// REPORT mode (the `predev`/`prebuild` hooks) warns (never blocks) when
// npm-managed deps or the SheetJS xlsx CDN tarball are behind their latest
// versions, and always exits 0 so `npm run dev` / `npm run build` can't be
// broken by a network blip or a stale version.
//
// UPDATE mode (`--update`) applies only SAFE, semver-respecting bumps:
//   • npm deps:   in-range bumps to `wanted` via `npm update <pkgs>`
//                 (your caret ranges in package.json are left untouched).
//   • xlsx (CDN): rewrite the pinned tarball URL to a newer version within
//                 the same major, then `npm install` to fetch it.
// Major/range-breaking bumps (and cross-major xlsx) are NEVER auto-applied;
// they're listed with the exact command to run yourself. If the registry/CDN
// is unreachable, the update is skipped with a warning (still exit 0).
//
// Dependency-free: uses only Node built-ins (child_process, fs, https).

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import https from "node:https";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");
const PKG = JSON.parse(readFileSync(PKG_PATH, "utf8"));
// Timeout for the lightweight version probes (npm metadata, docs scrape).
const TIMEOUT_MS = 5000;
// Generous timeout for `npm update` / `npm install`, which hit the network and
// may fetch multiple tarballs. Independent of TIMEOUT_MS above.
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

// --- HTTP fetch with timeout ----------------------------------------------
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { timeout: TIMEOUT_MS, headers: { "User-Agent": "update-check (node)" } },
      (res) => {
        // Follow a single redirect (docs.sheetjs.com may 301).
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchText(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          res.resume();
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
  });
}

// --- 1. npm-managed deps via `npm outdated --json` ------------------------
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
  // Drop git/tarball deps that npm can't resolve (current is often "missing"),
  // and exclude `xlsx` — it's a CDN tarball handled by checkXlsxCdn(), and
  // `npm update xlsx` cannot resolve it.
  const entries = Object.entries(parsed).filter(
    ([name, v]) =>
      name !== "xlsx" && v && v.current && v.latest && v.current !== v.latest
  );
  return entries.map(([name, v]) => ({
    name,
    current: v.current,
    wanted: v.wanted || v.current,
    latest: v.latest,
  }));
}

// --- 2. SheetJS xlsx CDN tarball ------------------------------------------
// package.json pins a tarball like
//   https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
// The CDN has no JSON endpoint and its index is JS-rendered, so discover the
// current version from the static docs page (install command embeds it).
async function checkXlsxCdn() {
  const raw = PKG.dependencies?.xlsx;
  if (typeof raw !== "string" || !raw.includes("cdn.sheetjs.com")) return null;
  const m = raw.match(/xlsx-(\d+\.\d+\.\d+)/);
  if (!m) return null;
  const pinned = m[1];

  const html = await fetchText("https://docs.sheetjs.com/docs/getting-started/installation/nodejs/");
  // Pick the highest version mentioned in the install tarball URLs.
  const versions = [...html.matchAll(/xlsx-(\d+\.\d+\.\d+)/g)].map((x) => x[1]);
  const latest = versions
    .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
    .sort((a, b) => cmpSemver(b, a))[0];
  if (!latest) throw new Error("could not parse latest version from docs page");
  return { pinned, latest };
}

function cmpSemver(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// --- 3. Safe-update planning & application (--update mode) -----------------
// A bump is "safe" (auto-eligible) when it stays within the same major version.
// Isolated so the rule can be tightened (e.g. to same-minor for major-0) in
// one place. For xlsx the rule is identical: same major segment.
function isSafeBump(pinned, latest) {
  return Number(pinned.split(".")[0]) === Number(latest.split(".")[0]);
}

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

// Rewrite the pinned xlsx CDN tarball URL in package.json to `latest` (a
// same-major version) and run `npm install` to fetch it + refresh the lockfile.
// Reads package.json as text to preserve formatting; throws if the URL pattern
// is missing so we never silently corrupt the file.
function applyXlsxUpdate(latest) {
  const before = readFileSync(PKG_PATH, "utf8");
  // Match e.g. ...xlsx-0.20.3/xlsx-0.20.3.tgz in both slots.
  const re = /(xlsx-)(\d+\.\d+\.\d+)(\/xlsx-)(\d+\.\d+\.\d+)(\.tgz)/;
  if (!re.test(before)) {
    throw new Error("could not find xlsx CDN tarball URL pattern in package.json");
  }
  const after = before.replace(re, `$1${latest}$3${latest}$5`);
  writeFileSync(PKG_PATH, after, "utf8");

  const res = spawnSync("npm install", {
    cwd: ROOT,
    stdio: "inherit",
    timeout: APPLY_TIMEOUT_MS,
    shell: true,
  });
  if (res.status !== 0) {
    // Roll back the package.json edit so we don't leave a half-applied bump.
    writeFileSync(PKG_PATH, before, "utf8");
    throw new Error(`npm install exited ${res.status}`);
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
// Shared probe: runs both checks, each reporting its own failure mode.
async function probe() {
  let npmOutdated = null;
  let npmErr = null;
  try {
    npmOutdated = checkNpmDeps();
  } catch (e) {
    npmErr = e;
  }

  let xlsx = null;
  let xlsxErr = null;
  try {
    xlsx = await checkXlsxCdn();
  } catch (e) {
    xlsxErr = e;
  }

  return { npmOutdated, npmErr, xlsx, xlsxErr };
}

// Default (no-flag) mode: non-mutating warning, printed in a box when anything
// is outdated or a single quiet line when everything is current.
function runReport({ npmOutdated, npmErr, xlsx, xlsxErr }) {
  // Both failed -> network/registry is down. Fail open but loud.
  if (npmErr && xlsxErr) {
    console.log(
      color.red(
        `[update-check] WARNING: could not reach registry/CDN — update check skipped. (${shortErr(xlsxErr)})`
      )
    );
    return;
  }

  // One side failed -> report that side's warning, proceed with the other.
  const lines = [];
  if (npmErr) {
    lines.push(color.red(`npm deps: check failed (${shortErr(npmErr)})`));
  } else if (npmOutdated.length === 0) {
    lines.push(`${color.bold("npm deps:")} ${color.dim("all up to date")}`);
  } else {
    lines.push(color.yellow(`npm deps: ${npmOutdated.length} outdated`));
    for (const d of npmOutdated) {
      lines.push(`   ${color.dim("•")} ${pad(d.name, 22)} ${d.current} ${color.dim("→")} ${color.yellow(d.latest)}`);
    }
  }

  if (xlsxErr) {
    lines.push(color.red(`xlsx (CDN): check failed (${shortErr(xlsxErr)})`));
  } else if (xlsx) {
    if (cmpSemver(xlsx.pinned, xlsx.latest) < 0) {
      lines.push(
        color.yellow(`xlsx (CDN): ${xlsx.pinned} ${color.dim("→")} ${xlsx.latest}  available`)
      );
    } else {
      lines.push(`${color.bold("xlsx (CDN):")} ${xlsx.pinned} ${color.dim("(latest)")}`);
    }
  }

  const anyOutdated =
    (!npmErr && npmOutdated.length > 0) || (!xlsxErr && xlsx && cmpSemver(xlsx.pinned, xlsx.latest) < 0);

  if (anyOutdated) {
    lines.push(
      color.dim("  Apply safe updates with `npm run update:deps`, or run `npm outdated` and bump manually.")
    );
    printBox(lines);
  } else {
    // Quiet single line when fully current.
    console.log(`${color.dim("[update-check] all dependencies up to date")}`);
  }
}

// `--update` mode: apply safe semver bumps, then list majors for manual review.
function runUpdate(state) {
  const { npmOutdated, npmErr, xlsx, xlsxErr } = state;

  // Can't update safely without knowing what's available.
  if (npmErr && xlsxErr) {
    console.log(
      color.red(
        `[update-check] WARNING: could not reach registry/CDN — update skipped. (${shortErr(xlsxErr)})`
      )
    );
    return;
  }

  console.log(color.bold("update-check — applying safe updates\n"));
  const applied = [];
  const review = [];

  // --- npm deps: in-range bumps via `npm update` --------------------------
  if (!npmErr) {
    const { apply, review: majors } = planNpmUpdates(npmOutdated);
    for (const d of apply) applied.push(`npm   ${d.name} ${d.current} → ${d.wanted}`);
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
  } else {
    console.log(color.red(`npm deps: check failed (${shortErr(npmErr)}) — skipped`));
  }

  // --- xlsx CDN: same-major URL bump + `npm install` ----------------------
  if (!xlsxErr && xlsx && cmpSemver(xlsx.pinned, xlsx.latest) < 0) {
    if (isSafeBump(xlsx.pinned, xlsx.latest)) {
      try {
        applyXlsxUpdate(xlsx.latest);
        applied.push(`xlsx   ${xlsx.pinned} → ${xlsx.latest}`);
      } catch (e) {
        console.log(color.red(`  xlsx update failed (${shortErr(e)}) — skipped`));
      }
    } else {
      // Cross-major xlsx bump (e.g. 0.x → 1.x): manual review.
      review.push({
        name: "xlsx",
        current: xlsx.pinned,
        latest: xlsx.latest,
        manual: `edit the xlsx tarball URL in package.json (${xlsx.pinned} → ${xlsx.latest})`,
      });
    }
  }

  // --- Results ------------------------------------------------------------
  for (const line of applied) {
    console.log(`  ${color.cyan("✓ applied")} ${line}`);
  }
  if (review.length > 0) {
    console.log(`\n  ${color.yellow("manual review (majors / range-breaking):")}`);
    for (const d of review) {
      const cmd = d.manual ?? `npm install ${d.name}@latest`;
      console.log(`   ${color.dim("•")} ${pad(d.name, 22)} ${d.current} ${color.dim("→")} ${color.yellow(d.latest)}  ${color.dim(cmd)}`);
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

async function main() {
  const state = await probe();
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

main().catch((e) => {
  // Genuine internal bug — loud, but still non-blocking (exit 0).
  console.error(color.red(`[update-check] internal error: ${shortErr(e)}`));
});
// Never throw: process always exits 0 (run as a pre* hook).
process.exitCode = 0;
