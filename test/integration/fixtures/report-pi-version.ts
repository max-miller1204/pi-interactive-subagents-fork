import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const reportPath = process.env.PI_TEST_REPORT_PI_EXECUTABLE;
if (reportPath) {
  const executable = execFileSync("/bin/sh", ["-c", "command -v pi"], {
    encoding: "utf8",
  }).trim();
  const version = execFileSync("pi", ["--version"], { encoding: "utf8" }).trim();
  writeFileSync(reportPath, JSON.stringify({ executable, version }), "utf8");
}

export default function (_pi: ExtensionAPI): void {}
