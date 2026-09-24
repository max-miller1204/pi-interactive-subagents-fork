#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const ISOLATED_TMUX_FLAG = "--isolated-tmux";

const args = process.argv.slice(2);
const isolateTmux = args.includes(ISOLATED_TMUX_FLAG);
const nodeArgs = args.filter((arg) => arg !== ISOLATED_TMUX_FLAG);

const testEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("PI_SUBAGENT_")),
);

/**
 * Start a private tmux server for the integration tests.
 * The tests then never create panes in the tmux session of the person who runs them.
 * The server has no attached client, so focus changes come only from the tests.
 */
function startIsolatedTmux(environment) {
  const socketName = `pi-subagents-test-${process.pid}`;
  // Start the server outside any current tmux session and without the user's tmux.conf.
  const serverEnvironment = { ...environment };
  delete serverEnvironment.TMUX;
  delete serverEnvironment.TMUX_PANE;
  const tmux = (tmuxArgs) =>
    execFileSync("tmux", ["-L", socketName, ...tmuxArgs], {
      encoding: "utf8",
      env: serverEnvironment,
    }).trim();

  const [paneId, serverPid, sessionId] = tmux([
    "-f", "/dev/null",
    "new-session", "-d", "-s", "tests", "-x", "240", "-y", "60",
    "-P", "-F", "#{pane_id} #{pid} #{session_id}",
  ]).split(" ");
  const socketPath = tmux(["display-message", "-p", "-t", paneId, "#{socket_path}"]);
  let stopped = false;

  return {
    socketName,
    environment: {
      ...serverEnvironment,
      // tmux clients use the socket in TMUX. The tests use TMUX_PANE as the parent pane.
      TMUX: `${socketPath},${serverPid},${sessionId.replace(/^\$/, "")}`,
      TMUX_PANE: paneId,
    },
    stop() {
      // Ctrl-C can reach both the signal handler and the finally block.
      if (stopped) return;
      stopped = true;
      execFileSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore", env: serverEnvironment });
      // tmux can leave the socket file behind after kill-server.
      rmSync(socketPath, { force: true });
    },
  };
}

const isolated = isolateTmux ? startIsolatedTmux(testEnvironment) : null;
if (isolated) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      isolated.stop();
      process.exit(1);
    });
  }
}

let result;
try {
  result = spawnSync(process.execPath, nodeArgs, {
    env: isolated?.environment ?? testEnvironment,
    stdio: "inherit",
  });
} finally {
  isolated?.stop();
}

if (result.error) {
  console.error(`Cannot start tests: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`Tests stopped with signal ${result.signal}.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
