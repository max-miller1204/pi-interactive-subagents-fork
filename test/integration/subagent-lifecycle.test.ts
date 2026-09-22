/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn real Pi sessions with real model calls.
 * Each test creates a tmux pane, runs pi with a task that uses the subagent
 * tool, and verifies the outcome via marker files and screen output.
 *
 * Cost depends on the configured model.
 * Duration: ~30-90s per test.
 *
 * Run inside tmux:
 *   tmux new 'npm run test:integration'
 *
 * Configuration:
 *   PI_TEST_MODEL     — optional model override; the Pi default is used when omitted
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  trackTempFile,
  readScreen,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  tmux is not available — skipping subagent lifecycle integration tests");
  console.log("   Run inside tmux to enable these tests.");
}

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 3 }, () => {
    let env: TestEnv;

    beforeEach(() => {
      env = createTestEnv();
    });

    afterEach(() => {
      cleanupTestEnv(env);
    });

    // ── Basic spawn + completion ──

    it("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      const activityPathFile = `/tmp/pi-integ-activity-path-${id}.txt`;
      trackTempFile(env, markerFile);
      trackTempFile(env, activityPathFile);

      const surface = createTrackedSurface(env, `echo-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'; printf '%s' \"$PI_SUBAGENT_ACTIVITY_FILE\" > '${activityPathFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: subagent created the marker file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
      assert.ok(
        content.includes(`PASS_${id}`),
        `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
      );

      // Verify: the final activity snapshot is written before the child exits.
      const activityFile = (await waitForFile(activityPathFile, PI_TIMEOUT)).trim();
      const activity = JSON.parse(
        await waitForFile(activityFile, PI_TIMEOUT, /"latestEvent":"agent_settled"/),
      );
      assert.equal(activity.latestEvent, "agent_settled");
      assert.equal(activity.phase, "done");

      // The activity path identifies the parent session artifact directory.
      // Find its session file by header ID, not by screen text or pane state.
      const parentId = basename(dirname(dirname(activityFile)));
      const sessionDir = dirname(dirname(dirname(dirname(activityFile))));
      const parentSession = readdirSync(sessionDir)
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => join(sessionDir, file))
        .find((file) => JSON.parse(readFileSync(file, "utf8").split("\n")[0]).id === parentId);
      assert.ok(parentSession, `Parent session ${parentId} should exist`);

      // A persisted result with exitCode 0 is written only after the child
      // process exits and the parent watcher receives its exit status.
      let result: any;
      const deadline = Date.now() + PI_TIMEOUT;
      while (Date.now() < deadline) {
        const entries = readFileSync(parentSession, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        result = entries.find((entry) => entry.type === "custom_message" &&
          entry.customType === "subagent_result" && entry.details?.name === `Echo-${id}`);
        if (result) break;
        await sleep(2000);
      }
      assert.ok(result, "Parent session must persist the subagent_result");
      assert.equal(result.details.exitCode, 0, "Child must exit successfully");
      const sessionFile = result.details.sessionFile;
      assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);
      const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
      assert.ok(lines.length >= 2, `Session should have at least two entries, got ${lines.length}`);
      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.ok(header.id);
      await waitForScreen(surface, /INTEGRATION_COMPLETE/, PI_TIMEOUT);
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from surfacing false stalled status", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-status-${id}.txt`;
      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `status-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Status-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readScreen(surface, 300);
      assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
      assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

      const completionScreen = await waitForScreen(
        surface,
        /STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
        PI_TIMEOUT,
        300,
      );
      assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
    });

    // ── Parallel subagent spawn ──

    it("spawns two subagents in parallel and both complete", async () => {
      const id = uniqueId();
      const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
      const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
      trackTempFile(env, fileA);
      trackTempFile(env, fileB);

      const surface = createTrackedSurface(env, `parallel-${id}`);
      await sleep(1000);

      const task = [
        `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
        ``,
        `First call:`,
        `  name: "ParaA-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
        ``,
        `Call both subagent tools NOW, do not wait between them.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Both marker files should appear
      const [contentA, contentB] = await Promise.all([
        waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
        waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
      ]);

      assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
      assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
    });

    // ── Fork mode ──

    it("fork mode creates a child session linked to the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `fork-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Fork-${id}"`,
        `  agent: "test-fork"`,
        `  task: "Run this bash command: echo \"$PI_SUBAGENT_SESSION\" > '${markerFile}'"`,
        `Do not set a fork parameter. The test-fork agent profile enables fork mode.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The child reports its session path through the launch environment.
      const sessionFile = (await waitForFile(markerFile, PI_TIMEOUT, /\.jsonl\s*$/)).trim();
      assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

      await waitForScreen(surface, /FORK_COMPLETE|completed|Sub-agent.*"Fork/i, PI_TIMEOUT);

      const entries = readFileSync(sessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const header = entries[0];
      assert.equal(header.type, "session", "First entry should be session header");
      assert.equal(typeof header.parentSession, "string");
      const parentSessionFile = header.parentSession as string;
      assert.notEqual(parentSessionFile, sessionFile);
      assert.ok(
        existsSync(parentSessionFile),
        `Parent session file should exist: ${parentSessionFile}`,
      );

      const parentEntries = readFileSync(parentSessionFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      let truncateAt = parentEntries.length;
      for (let index = parentEntries.length - 1; index >= 0; index--) {
        if (
          parentEntries[index].type === "message" &&
          parentEntries[index].message?.role === "user"
        ) {
          truncateAt = index;
          break;
        }
      }
      const expectedForkContext = parentEntries
        .slice(0, truncateAt)
        .filter((entry) => entry.type !== "session");
      assert.ok(expectedForkContext.length > 0, "Parent session should provide fork context");
      assert.deepEqual(
        entries.slice(1, expectedForkContext.length + 1),
        expectedForkContext,
        "Fork session should start with copied parent context",
      );
    });

    // ── caller_ping ──

    it("subagent caller_ping sends notification back to the parent", async () => {
      const id = uniqueId();

      const surface = createTrackedSurface(env, `ping-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Ping-${id}"`,
        `  agent: "test-ping"`,
        `  task: "PING_TEST_${id}"`,
        `Just call the subagent tool once. Do not do anything else before calling it.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-ping agent calls caller_ping, which steers a "needs help" message
      // back to the outer pi. Look for it on screen.
      const screen = await waitForScreen(
        surface,
        /needs help|PING|caller_ping|ping/i,
        PI_TIMEOUT,
      );

      assert.ok(
        /needs help|PING/i.test(screen),
        `Screen should show ping notification. Got:\n${screen.slice(-800)}`,
      );
    });

    // ── Agent discovery ──

    it("subagent discovers project-local test agents", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `discovery-${id}`);
      await sleep(1000);

      // Use subagents_list to verify test agents are discoverable,
      // then spawn one to prove it works end-to-end.
      const task = [
        `First, call the subagents_list tool to see available agents.`,
        `Then call the subagent tool:`,
        `  name: "Disco-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent (discovered from project .pi/agents/) should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
    });

    // ── Subagent with custom system prompt ──

    it("passes systemPrompt to subagent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `sysprompt-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these parameters:`,
        `  name: "SysP-${id}"`,
        `  agent: "test-echo"`,
        `  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
        `  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
        `After the subagent completes, say SYSPROMPT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
      assert.ok(content.includes(`SYSPROMPT_${id}`), `System prompt test marker should exist`);
    });
  });
}
