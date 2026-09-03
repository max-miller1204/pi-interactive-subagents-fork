import { execFileSync } from "node:child_process";
import {
  closeSurface,
  pollForExit,
  readScreen,
} from "/Users/maxmiller/.no-mistakes/worktrees/807bca8f50f2/01M1JYXSW1PXJRQCHAPBW3VDDY/pi-extension/subagents/tmux.ts";

const session = `pi-evidence-${process.pid}`;
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

  const dimensions = execFileSync(
    "tmux",
    ["display-message", "-p", "-t", surface, "#{pane_width}x#{pane_height}"],
    { encoding: "utf8" },
  ).trim();
  const physicalScreen = readScreen(surface, 50);
  const started = Date.now();
  const result = await pollForExit(surface, AbortSignal.timeout(5_000), { interval: 50 });
  const elapsedMs = Date.now() - started;

  console.log(`pane=${surface} dimensions=${dimensions}`);
  console.log(`ordinary_capture_contains_complete_marker=${/__SUBAGENT_DONE_0__/.test(physicalScreen)}`);
  console.log(`ordinary_capture_rows=${JSON.stringify(physicalScreen.split("\n").filter(Boolean))}`);
  console.log(`poll_result=${JSON.stringify(result)} elapsed_ms=${elapsedMs} resize_performed=false`);

  closeSurface(surface);
  surface = undefined;
  let sessionExists = true;
  try {
    execFileSync("tmux", ["has-session", "-t", session], { stdio: "ignore" });
  } catch {
    sessionExists = false;
  }
  console.log(`cleanup_complete=${!sessionExists} session_exists=${sessionExists}`);
} finally {
  if (surface) {
    try {
      execFileSync("tmux", ["kill-session", "-t", session]);
    } catch {}
  }
}
