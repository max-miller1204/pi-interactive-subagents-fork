import { execFileSync } from "node:child_process";
import {
  closeSurface,
  pollForExit,
  readScreen,
} from "/Users/maxmiller/.no-mistakes/evidence/01M1JYXSW1PXJRQCHAPBW3VDDY/base-tmux.ts";

const session = `pi-baseline-${process.pid}`;
let surface;

try {
  surface = execFileSync(
    "tmux",
    ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, "-x", "1", "-y", "2"],
    { encoding: "utf8" },
  ).trim();
  execFileSync("tmux", ["set-option", "-t", session, "remain-on-exit", "on"]);
  execFileSync("tmux", [
    "respawn-pane",
    "-k",
    "-t",
    surface,
    "printf '%s\\n' '__SUBAGENT_DONE_0__'",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 200));

  const screen = readScreen(surface, 50);
  console.log(`baseline_ordinary_capture_contains_complete_marker=${/__SUBAGENT_DONE_0__/.test(screen)}`);
  const started = Date.now();
  try {
    const result = await pollForExit(surface, AbortSignal.timeout(750), { interval: 50 });
    console.log(`baseline_unexpected_poll_result=${JSON.stringify(result)}`);
    process.exitCode = 1;
  } catch (error) {
    console.log(`baseline_poll_timed_out=true elapsed_ms=${Date.now() - started}`);
    console.log(`baseline_reproduces_reported_stuck_pane=${/Abort/.test(String(error))}`);
  }
} finally {
  if (surface) {
    try {
      closeSurface(surface);
    } catch {}
  }
}
