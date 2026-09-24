/**
 * Integration tests for the tmux surface layer.
 *
 * These tests exercise real tmux operations: creating panes,
 * sending commands, reading screen output, and closing panes.
 * No LLM calls — fast and free.
 *
 * Run inside tmux:
 *   tmux new 'npm run test:integration'
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  createTrackedSurfaceSplit,
  focusSurface,
  getFocusedSurface,
  waitForFocusedSurface,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  shellEscape,
  readScreen,
  readScreenAsync,
  closeSurface,
  pollForExit,
  sleep,
  uniqueId,
  trackTempFile,
  waitForFile,
  waitForScreen,
  startPi,
  PI_EXECUTABLE,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
const REPORT_PI_VERSION_EXTENSION = fileURLToPath(
  new URL("./fixtures/report-pi-version.ts", import.meta.url),
);
const FOCUS_TEST_PANE_STARTUP_MS = 2500;

if (backends.length === 0) {
  console.log("⚠️  tmux is not available — skipping tmux-surface integration tests");
  console.log("   Run inside tmux to enable these tests.");
}

for (const backend of backends) {
  describe(`tmux-surface [${backend}]`, { timeout: 60_000 }, () => {
    let env: TestEnv;

    beforeEach(() => {
      env = createTestEnv();
    });

    afterEach(() => {
      cleanupTestEnv(env);
    });

    it("keeps focus on the active surface while creating and targeting subagent surfaces", async () => {
      const anchor = createTrackedSurfaceSplit(env, "focus-anchor", "right");
      await sleep(1000);

      focusSurface(anchor);
      await waitForFocusedSurface(anchor, 10_000);

      const childA = createTrackedSurface(env, "focus-child-a");
      await sleep(FOCUS_TEST_PANE_STARTUP_MS);
      assert.equal(getFocusedSurface(), anchor);

      const childB = createTrackedSurface(env, "focus-child-b");
      await sleep(FOCUS_TEST_PANE_STARTUP_MS);
      assert.equal(getFocusedSurface(), anchor);

      // Keep focus markers short enough to remain contiguous in narrow CI panes.
      const markerA = Math.random().toString(36).slice(2, 6);
      const markerB = Math.random().toString(36).slice(2, 6);
      sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
      sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(), anchor);
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      assert.ok(
        screen.replace(/\s+/g, "").includes(`MARKER_${marker}`),
        `Expected screen to contain MARKER_${marker}. Got:\n${screen}`,
      );

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("cleans untracked child panes in the tracked test window", () => {
      const parent = createTrackedSurface(env, "cleanup-parent");
      const child = execFileSync(
        "tmux",
        ["split-window", "-d", "-t", parent, "-c", env.dir, "-P", "-F", "#{pane_id}"],
        { encoding: "utf8" },
      ).trim();

      cleanupTestEnv(env);

      const remainingPanes = new Set(
        execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], {
          encoding: "utf8",
        })
          .trim()
          .split("\n"),
      );
      assert.equal(remainingPanes.has(parent), false);
      assert.equal(remainingPanes.has(child), false);
    });

    it("cleans child panes created while the parent closes", () => {
      const anchor = execFileSync(
        "tmux",
        ["new-window", "-d", "-P", "-F", "#{pane_id}"],
        { encoding: "utf8" },
      ).trim();
      try {
        const parent = execFileSync(
          "tmux",
          ["split-window", "-d", "-t", anchor, "-P", "-F", "#{pane_id}"],
          { encoding: "utf8" },
        ).trim();
        env.surfaces.push(parent);
        // Complete a pending child split when cleanup closes the parent.
        execFileSync("tmux", [
          "set-hook", "-t", anchor, "after-kill-pane",
          `set-hook -u -t ${anchor} after-kill-pane ; split-window -d -t ${anchor} -c ${shellEscape(env.dir)}`,
        ]);

        cleanupTestEnv(env);

        const remainingPanes = execFileSync(
          "tmux", ["list-panes", "-t", anchor, "-F", "#{pane_id}"],
          { encoding: "utf8" },
        ).trim().split("\n");
        assert.deepEqual(remainingPanes, [anchor]);
      } finally {
        execFileSync("tmux", ["kill-window", "-t", anchor]);
      }
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await sleep(1000);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      await sleep(1500);

      const screen = readScreen(surface, 50);
      const compact = screen.replace(/\s+/g, "");
      assert.ok(
        compact.includes(`SPEC_${marker}`),
        `Expected special-char output. Got:\n${screen}`,
      );
      // $ should be literal inside single quotes
      assert.ok(
        compact.includes("$HOME"),
        `Expected literal $HOME in output. Got:\n${screen}`,
      );
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await sleep(1000);

      const marker = uniqueId();
      const markerFile = `/tmp/pi-tmux-long-command-${marker}.txt`;
      trackTempFile(env, markerFile);
      const expected = `LONG_${marker}_${"X".repeat(500)}_END`;

      sendLongCommand(surface, `printf %s ${expected} > ${markerFile}`);
      const content = await waitForFile(markerFile, 10_000, /_END$/);
      assert.equal(content, expected);
    });

    it("launches a script even when the pane shell would consume typed input", async () => {
      const surface = execFileSync(
        "tmux",
        [
          "split-window",
          "-d",
          "-h",
          "-P",
          "-F",
          "#{pane_id}",
          `sh -c 'IFS= read -r ignored; exec "\${SHELL:-/bin/sh}"'`,
        ],
        { encoding: "utf8" },
      ).trim();
      assert.ok(surface.startsWith("%"), `Expected tmux pane id, got ${surface}`);
      env.surfaces.push(surface);

      const marker = uniqueId();
      const markerFile = `/tmp/pi-tmux-atomic-launch-${marker}.txt`;
      trackTempFile(env, markerFile);

      sendLongCommand(surface, `printf %s ${marker} > ${markerFile}`);
      const content = await waitForFile(markerFile, 5_000, new RegExp(marker));
      assert.equal(content, marker);
    });

    it("launches with the parent environment without stale subagent controls", async () => {
      const surface = createTrackedSurface(env, "parent-environment-test");
      const marker = uniqueId();
      const markerFile = `/tmp/pi-tmux-parent-environment-${marker}.txt`;
      const parentValue = `parent-${marker}`;
      const pathComponent = join(env.dir, `parent-path-${marker}`);
      const expectedPiExecutable = join(pathComponent, "pi");
      const replacementAllowed = `replacement-${marker}`;
      const completionMarker = `complete-${marker}`;
      const originalParentValue = process.env.PI_TMUX_PARENT_ONLY;
      const originalStaleValue = process.env.PI_SUBAGENT_STALE_ONLY;
      const originalPath = process.env.PATH;
      const session = execFileSync(
        "tmux",
        ["display-message", "-p", "-t", surface, "#{session_id}"],
        { encoding: "utf8" },
      ).trim();
      const staleSessionControls = [
        ["PI_SUBAGENT_AUTO_EXIT", "1"],
        ["PI_SUBAGENT_ALLOWED", `stale-allowed-${marker}`],
        ["PI_SUBAGENT_SURFACE", `stale-surface-${marker}`],
      ] as const;
      const previousSessionControls = staleSessionControls.map(([name]) => {
        try {
          const current = execFileSync(
            "tmux",
            ["show-environment", "-t", session, name],
            { encoding: "utf8" },
          ).trim();
          return [name, current.slice(name.length + 1)] as const;
        } catch {
          return [name, undefined] as const;
        }
      });
      trackTempFile(env, markerFile);
      mkdirSync(pathComponent);
      writeFileSync(expectedPiExecutable, "#!/bin/sh\nprintf 'parent-path-pi\\n'\n", {
        mode: 0o755,
      });

      try {
        process.env.PI_TMUX_PARENT_ONLY = parentValue;
        process.env.PI_SUBAGENT_STALE_ONLY = `stale-${marker}`;
        process.env.PATH = `${pathComponent}:${originalPath ?? ""}`;
        for (const [name, value] of staleSessionControls) {
          execFileSync("tmux", ["set-environment", "-t", session, name, value]);
        }

        const innerCommand = `printf '%s\\n' "$PI_TMUX_PARENT_ONLY" "$PATH" "$(command -v pi)" "\${PI_SUBAGENT_STALE_ONLY-unset}" "\${PI_SUBAGENT_AUTO_EXIT-unset}" "$PI_SUBAGENT_ALLOWED" "\${PI_SUBAGENT_SURFACE-unset}" "$TMUX_PANE" "${completionMarker}" > ${markerFile}`;
        sendLongCommand(
          surface,
          `PI_SUBAGENT_ALLOWED=${replacementAllowed} bash -c ${shellEscape(innerCommand)}`,
        );
        const content = await waitForFile(markerFile, 5_000, new RegExp(completionMarker));
        const [
          actualParentValue,
          actualPath,
          actualPiExecutable,
          staleParentControl,
          staleAutoExit,
          actualAllowed,
          staleSurface,
          childPane,
          actualCompletionMarker,
        ] = content.trim().split("\n");

        assert.equal(actualParentValue, parentValue);
        const actualPathComponents = actualPath?.split(":") ?? [];
        const expectedPathComponents = [pathComponent, ...(originalPath ?? "").split(":")];
        assert.deepEqual(actualPathComponents.toSorted(), expectedPathComponents.toSorted());
        assert.equal(actualPiExecutable, expectedPiExecutable);
        assert.equal(staleParentControl, "unset");
        assert.equal(staleAutoExit, "unset");
        assert.equal(actualAllowed, replacementAllowed);
        assert.equal(staleSurface, "unset");
        assert.equal(childPane, surface);
        assert.equal(actualCompletionMarker, completionMarker);
      } finally {
        for (const [name, value] of previousSessionControls) {
          if (value === undefined) {
            execFileSync("tmux", ["set-environment", "-u", "-t", session, name]);
          } else {
            execFileSync("tmux", ["set-environment", "-t", session, name, value]);
          }
        }
        if (originalParentValue === undefined) delete process.env.PI_TMUX_PARENT_ONLY;
        else process.env.PI_TMUX_PARENT_ONLY = originalParentValue;
        if (originalStaleValue === undefined) delete process.env.PI_SUBAGENT_STALE_ONLY;
        else process.env.PI_SUBAGENT_STALE_ONLY = originalStaleValue;
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    });

    it("uses the dots-managed Pi for parent and child launches", async () => {
      const surface = createTrackedSurface(env, "pi-selection-test");
      const fakeBinDir = join(env.dir, "fake-bin");
      const markerFile = join(env.dir, "pi-selection.json");
      const previousPath = process.env.PATH;
      const previousReportPath = process.env.PI_TEST_REPORT_PI_EXECUTABLE;
      mkdirSync(fakeBinDir);
      writeFileSync(join(fakeBinDir, "pi"), "#!/bin/sh\nprintf '99.99.99\\n'\n", {
        mode: 0o755,
      });

      try {
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ""}`;
        process.env.PI_TEST_REPORT_PI_EXECUTABLE = markerFile;
        startPi(surface, env.dir, "report the selected Pi", {
          extraArgs:
            `--print --offline --no-session -e ${shellEscape(REPORT_PI_VERSION_EXTENSION)}`,
        });

        const report = JSON.parse(await waitForFile(markerFile, 15_000));
        const localBin = join(fileURLToPath(new URL("../..", import.meta.url)), "node_modules", ".bin");
        const externalPath = (previousPath ?? "").split(":").filter((dir) => dir !== localBin).join(":");
        const globalPi = execFileSync("which", ["pi"], {
          encoding: "utf8",
          env: { ...process.env, PATH: externalPath },
        }).trim();
        const expectedVersion = execFileSync(globalPi, ["--version"], { encoding: "utf8" }).trim();
        assert.deepEqual(report, { executable: globalPi, version: expectedVersion });
        assert.equal(PI_EXECUTABLE, globalPi);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousReportPath === undefined) delete process.env.PI_TEST_REPORT_PI_EXECUTABLE;
        else process.env.PI_TEST_REPORT_PI_EXECUTABLE = previousReportPath;
      }
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await sleep(1000);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await sleep(1500);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(
        screen.replace(/\s+/g, "").includes(`ASYNC_${marker}`),
        `Async read should find marker. Got:\n${screen}`,
      );
    });

    it("detects a completion sentinel at tmux's one-column pane limit", async () => {
      const session = `pi-wrap-${uniqueId()}`;
      let surface = "";

      try {
        surface = execFileSync(
          "tmux",
          ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", session, "-x", "1", "-y", "2"],
          { encoding: "utf8" },
        ).trim();
        execFileSync("tmux", ["set-option", "-t", session, "remain-on-exit", "on"]);
        execFileSync(
          "tmux",
          ["respawn-pane", "-k", "-t", surface, `printf '%s\\n' '__SUBAGENT_DONE_0__'`],
        );
        await sleep(200);

        const unjoinedScreen = readScreen(surface, 5);
        assert.doesNotMatch(
          unjoinedScreen,
          /__SUBAGENT_DONE_0__/,
          `Test requires the sentinel to wrap at one column. Got:\n${unjoinedScreen}`,
        );

        const result = await pollForExit(surface, AbortSignal.timeout(5_000), { interval: 50 });
        assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
      } finally {
        try {
          execFileSync("tmux", ["kill-session", "-t", session]);
        } catch {}
      }
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await sleep(1500);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);
      await sleep(1500);

      const screen1 = readScreen(s1, 50);
      const screen2 = readScreen(s2, 50);
      const compact1 = screen1.replace(/\s+/g, "");
      const compact2 = screen2.replace(/\s+/g, "");

      assert.ok(compact1.includes(`S1_${m1}`), `Surface 1 missing marker. Got:\n${screen1}`);
      assert.ok(compact2.includes(`S2_${m2}`), `Surface 2 missing marker. Got:\n${screen2}`);
    });

    it("writes output to a file and verifies via surface", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await sleep(1000);

      const marker = uniqueId();
      const filePath = `/tmp/pi-tmux-test-${marker}.txt`;

      sendCommand(surface, `echo "FILE_${marker}" > ${filePath} && echo "WRITTEN_${marker}"`);

      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      // Clean up
      try {
        unlinkSync(filePath);
      } catch {}
    });
  });
}
