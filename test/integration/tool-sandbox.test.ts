import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { __test__ as subagentTestApi } from "../../pi-extension/subagents/index.ts";
import { shellEscape } from "../../pi-extension/subagents/tmux.ts";
import type { SubagentLoadout } from "../../pi-extension/subagents/session.ts";

const fixtureProvider = fileURLToPath(new URL("./fixtures/tool-provider.ts", import.meta.url));
const controlExtension = fileURLToPath(
  new URL("../../pi-extension/subagents/subagent-done.ts", import.meta.url),
);

describe("restricted tool-extension sandbox", () => {
  it("loads only pinned extensions and activates only allowlisted tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tool-sandbox-"));
    try {
      const agentDir = join(dir, "agent");
      const blockedMarker = join(dir, "blocked-extension-loaded");
      const blockedExtension = join(agentDir, "extensions", "blocked.ts");
      mkdirSync(dirname(blockedExtension), { recursive: true });
      writeFileSync(
        blockedExtension,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(blockedMarker)}, "loaded", "utf8");`,
          "export default function () {}",
        ].join("\n"),
        "utf8",
      );

      const loadout: SubagentLoadout = {
        version: 3,
        agent: "integration",
        toolAllowlist: "allowed_tool",
        toolExtensions: { allowed_tool: fixtureProvider },
        controlExtension,
        nativeTools: [],
        model: "openai-codex/gpt-5.3-codex-spark",
        modelProviderExtension: null,
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: true,
        cwd: dir,
        agentDir,
      };
      const parts = ["pi", "--print", "--offline", "--no-session"];
      subagentTestApi.applySandboxToParts(parts, loadout, {
        artifactDir: dir,
        name: "integration",
      });
      parts.push(shellEscape("inspect"));

      const result = spawnSync("sh", ["-lc", parts.join(" ")], {
        cwd: dir,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        encoding: "utf8",
        timeout: 30_000,
      });

      assert.equal(result.status, 0, `pi failed:\n${result.stdout}\n${result.stderr}`);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.match(output, /SANDBOX_ACTIVE=allowed_tool(?:\r?\n|$)/);
      assert.doesNotMatch(output, /other_tool/);
      assert.equal(existsSync(blockedMarker), false, "global extension discovery must stay disabled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads only pinned skills when the skill policy is allowlist", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-skill-sandbox-"));
    try {
      const agentDir = join(dir, "agent");
      const allowedSkill = join(dir, "allowed", "SKILL.md");
      const blockedSkill = join(agentDir, "skills", "blocked-skill", "SKILL.md");
      mkdirSync(dirname(allowedSkill), { recursive: true });
      mkdirSync(dirname(blockedSkill), { recursive: true });
      writeFileSync(
        allowedSkill,
        [
          "---",
          "name: allowed-skill",
          "description: Allowed integration test skill.",
          "---",
          "",
          "Use the allowed skill.",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        blockedSkill,
        [
          "---",
          "name: blocked-skill",
          "description: Blocked integration test skill.",
          "---",
          "",
          "Do not load this skill.",
        ].join("\n"),
        "utf8",
      );

      const loadout: SubagentLoadout = {
        version: 3,
        agent: "integration",
        toolAllowlist: "allowed_tool",
        toolExtensions: { allowed_tool: fixtureProvider },
        controlExtension,
        nativeTools: [],
        model: "openai-codex/gpt-5.3-codex-spark",
        modelProviderExtension: null,
        skillPolicy: "allowlist",
        skillPaths: { "allowed-skill": allowedSkill },
        thinking: null,
        systemPromptMode: null,
        identity: null,
        spawnable: null,
        autoExit: true,
        cwd: dir,
        agentDir,
      };
      const parts = ["pi", "--print", "--offline", "--no-session"];
      subagentTestApi.applySandboxToParts(parts, loadout, {
        artifactDir: dir,
        name: "integration",
      });
      parts.push(shellEscape("inspect"));

      const result = spawnSync("sh", ["-lc", parts.join(" ")], {
        cwd: dir,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        encoding: "utf8",
        timeout: 30_000,
      });

      assert.equal(result.status, 0, `pi failed:\n${result.stdout}\n${result.stderr}`);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.match(output, /SANDBOX_SKILLS=skill:allowed-skill(?:\r?\n|$)/);
      assert.doesNotMatch(output, /blocked-skill/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
