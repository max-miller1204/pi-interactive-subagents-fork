#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, "..");
const PI_EXECUTABLE = join(PROJECT_ROOT, "node_modules", ".bin", "pi");
const PACKAGE_NAMES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

function readInstalledVersion(packageName) {
  const packagePath = join(PROJECT_ROOT, "node_modules", packageName, "package.json");
  return JSON.parse(readFileSync(packagePath, "utf8")).version;
}

let piVersion;
let installedVersions;
try {
  piVersion = execFileSync(PI_EXECUTABLE, ["--version"], { encoding: "utf8" }).trim();
  installedVersions = Object.fromEntries(
    PACKAGE_NAMES.map((packageName) => [packageName, readInstalledVersion(packageName)]),
  );
} catch (error) {
  console.error("Cannot check Pi versions. Run `npm install`, then run this check again.");
  if (error instanceof Error) console.error(error.message);
  process.exit(1);
}

const mismatches = Object.entries(installedVersions).filter(
  ([, installedVersion]) => installedVersion !== piVersion,
);

if (mismatches.length > 0) {
  console.error("Pi versions do not match:");
  console.error(`  pi --version: ${piVersion}`);
  for (const [packageName, installedVersion] of Object.entries(installedVersions)) {
    console.error(`  ${packageName}: ${installedVersion}`);
  }
  console.error("\nUpdate the development dependencies with this command:");
  console.error(
    `  npm install --save-dev --save-exact ${PACKAGE_NAMES.map((name) => `${name}@${piVersion}`).join(" ")}`,
  );
  process.exit(1);
}

console.log(`Pi and development dependency versions match (${piVersion}).`);
