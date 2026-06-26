#!/usr/bin/env node
// Bump InterComm AIMFP version across ALL files that embed a version, then build.
// Mirrors AIMFP's dev/bump-version.py (interactive: shows current versions, then
// prompts for the new one — no need to open any file to check where it's at).
//
// Files kept in sync:
//   - package.json                ("version": "X.Y.Z")   ← the npm package version
//   - .claude-plugin/plugin.json  ("version": "X.Y.Z")   ← the Claude Code plugin version
//   - src/mcp-server.ts           (version: "X.Y.Z")     ← the McpServer() version the
//                                                           server reports over MCP
//   - package-lock.json                                  ← resynced via npm so a later
//                                                           `npm ci` cannot fail on drift
//
// Second part (mirrors AIMFP's rebuild): runs `npm run build` (tsc) so dist/ —
// what the published package ships — carries the new server version.
//
// Usage:
//   node dev/bump-version.mjs              # interactive: prints current, then prompts
//   node dev/bump-version.mjs <X.Y.Z>      # non-interactive (CI/scripts)
//   add --no-build to skip the rebuild

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Per-file match patterns. Each is (prefix-up-to-opening-quote)(value)(closing-quote)
// via groups 1 and 2, so the value is everything between them — this avoids the
// classic bug of matching the `"version"` KEY instead of its value.
const FILES = [
  {
    name: "package.json",
    path: join(ROOT, "package.json"),
    pattern: /("version"\s*:\s*")[^"]+(")/,
  },
  {
    name: ".claude-plugin/plugin.json",
    path: join(ROOT, ".claude-plugin", "plugin.json"),
    pattern: /("version"\s*:\s*")[^"]+(")/,
  },
  {
    name: "src/mcp-server.ts (McpServer version)",
    path: join(ROOT, "src", "mcp-server.ts"),
    // Unquoted key + a semver value, so this only matches the server version
    // literal and never a zod field or a comment.
    pattern: /(version:\s*")\d+\.\d+\.\d+(")/,
  },
];

const VERSION_RE = /^\d+\.\d+\.\d+$/;

const readVersion = (f) => {
  const m = readFileSync(f.path, "utf8").match(f.pattern);
  return m ? m[0].slice(m[1].length, m[0].length - m[2].length) : null;
};

const writeVersion = (f, v) => {
  const text = readFileSync(f.path, "utf8");
  const next = text.replace(f.pattern, `$1${v}$2`);
  if (next === text) return false;
  writeFileSync(f.path, next);
  return true;
};

const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

// ---- show current versions + sync check -------------------------------------
console.log("InterComm AIMFP Version Bumper");
console.log("=".repeat(40));
console.log("\nCurrent versions:");
const found = FILES.map((f) => {
  const v = readVersion(f);
  console.log(`  ${f.name}: ${v ?? "(not found)"}`);
  return v;
});
const unique = [...new Set(found.filter(Boolean))];
const current = unique.length === 1 ? unique[0] : null;
if (unique.length > 1) console.log("\n  WARNING: versions are out of sync!");
else if (current) console.log(`\n  All files at: ${current}`);

// ---- decide the new version (argv = non-interactive, else prompt) ------------
const args = process.argv.slice(2);
let newVersion = args.find((a) => !a.startsWith("--"));
const noBuild = args.includes("--no-build");
let runBuild = !noBuild;

if (newVersion) {
  if (!VERSION_RE.test(newVersion)) die(`\nInvalid version format: '${newVersion}' (expected X.Y.Z)`);
} else {
  const rl = createInterface({ input: stdin, output: stdout });
  const ans = (await rl.question(`\nNew version${current ? ` (current ${current})` : ""} — or 'q' to quit: `)).trim();
  if (!ans || ans.toLowerCase() === "q") { rl.close(); console.log("Aborted."); process.exit(0); }
  if (!VERSION_RE.test(ans)) { rl.close(); die(`Invalid version format: '${ans}' (expected X.Y.Z)`); }
  newVersion = ans;
  const confirm = (await rl.question(`Update all files to ${newVersion}? [y/N]: `)).trim().toLowerCase();
  if (confirm !== "y" && confirm !== "yes") { rl.close(); console.log("Aborted."); process.exit(0); }
  if (!noBuild) {
    const b = (await rl.question("Run build after bumping? [Y/n]: ")).trim().toLowerCase();
    runBuild = b !== "n" && b !== "no";
  }
  rl.close();
}

// ---- apply --------------------------------------------------------------------
console.log(`\nUpdating all files to: ${newVersion}`);
for (const f of FILES) {
  const ok = writeVersion(f, newVersion);
  console.log(`  ${f.name}: ${ok ? "updated" : "FAILED (pattern not found)"}`);
}

// Resync package-lock.json's version without touching node_modules or running
// native builds, so a later `npm ci` cannot fail on a version mismatch.
console.log("\nResyncing package-lock.json...");
try {
  execSync("npm install --package-lock-only --ignore-scripts", { cwd: ROOT, stdio: "inherit" });
} catch {
  console.log("  (could not resync lockfile automatically — run `npm install` once)");
}

if (!runBuild) {
  console.log("\nSkipped build. Remember: commit & push so CI publishes to npm.");
  process.exit(0);
}

console.log("\n--- Building (npm run build) ---");
execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
console.log(`\nDone. Next: commit & push so CI publishes intercomm-aimfp@${newVersion} to npm.`);
