#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const testEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("PI_SUBAGENT_")),
);
const result = spawnSync(process.execPath, process.argv.slice(2), {
  env: testEnvironment,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Cannot start tests: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`Tests stopped with signal ${result.signal}.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
