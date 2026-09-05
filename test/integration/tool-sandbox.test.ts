import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { __test__ as subagentTestApi } from "../../pi-extension/subagents/index.ts";
import { shellEscape } from "../../pi-extension/subagents/tmux.ts";
import { PI_EXECUTABLE } from "./harness.ts";
import type { SubagentLoadout } from "../../pi-extension/subagents/session.ts";

const fixtureProvider = fileURLToPath(new URL("./fixtures/tool-provider.ts", import.meta.url));
const controlExtension = fileURLToPath(
  new URL("../../pi-extension/subagents/subagent-done.ts", import.meta.url),
);

describe("restricted tool-extension sandbox", () => {
  it("pins Pi's winning skill file when directory resources contain duplicate names", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-skill-precedence-"));
    try {
      const roots = [join(dir, "first"), join(dir, "second")];
      for (const root of roots) {
        const skillDir = join(root, "nested");
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          join(skillDir, "SKILL.md"),
          "---\nname: duplicate-skill\ndescription: Test skill precedence.\n---\nUse this skill.\n",
        );
      }
      const result = spawnSync(PI_EXECUTABLE, [
        "--print", "--offline", "--no-session", "--no-extensions", "--no-skills",
        "--model", "openai-codex/gpt-5.3-codex-spark",
        "--tools", "allowed_tool", "-e", fixtureProvider,
        "--skill", roots[0], "--skill", roots[1], "inspect",
      ], {
        cwd: dir,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: join(dir, "agent"),
          PI_TEST_REPORT_SKILL_COMMANDS: "1",
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(result.status, 0, `pi failed:\n${output}`);
      const prefix = "SANDBOX_SKILL_COMMANDS=";
      const line = output.split(/\r?\n/).find((line) => line.startsWith(prefix));
      assert.ok(line, output);
      const commands = JSON.parse(line.slice(prefix.length));
      assert.equal(commands.length, 1);
      assert.equal(commands[0].name, "skill:duplicate-skill");
      const winningPath = join(roots[0], "nested", "SKILL.md");
      assert.equal(commands[0].sourceInfo.path, winningPath);
      const sandbox = subagentTestApi.resolveSkillSandbox(
        "allowlist", undefined, ["duplicate-skill"], commands,
      );
      assert.deepEqual({ ...sandbox.skillPaths }, { "duplicate-skill": winningPath });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const skillPolicy of ["none", "allowlist"] as const) {
    it(`permits trusted extension skill contributions with ${skillPolicy}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-extension-skill-"));
      try {
        const contributedSkill = join(dir, "contributed.md");
        const pinnedSkill = join(dir, "pinned.md");
        for (const [path, name] of [
          [contributedSkill, "contributed-skill"],
          [pinnedSkill, "pinned-skill"],
        ]) {
          writeFileSync(path, `---\nname: ${name}\ndescription: Test skill.\n---\nUse this skill.\n`);
        }
        const loadout: SubagentLoadout = {
          version: 3,
          agent: "integration",
          toolAllowlist: "allowed_tool",
          toolExtensions: { allowed_tool: fixtureProvider },
          controlExtension,
          nativeTools: [],
          model: "openai-codex/gpt-5.3-codex-spark",
          modelProviderExtension: null,
          skillPolicy,
          skillPaths: skillPolicy === "allowlist" ? { "pinned-skill": pinnedSkill } : {},
          thinking: null,
          systemPromptMode: null,
          identity: null,
          spawnable: null,
          autoExit: true,
          cwd: dir,
          agentDir: join(dir, "agent"),
        };
        const parts = [shellEscape(PI_EXECUTABLE), "--print", "--offline", "--no-session"];
        subagentTestApi.applySandboxToParts(parts, loadout, { artifactDir: dir, name: "integration" });
        parts.push(shellEscape("inspect"));
        const result = spawnSync("sh", ["-lc", parts.join(" ")], {
          cwd: dir,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: loadout.agentDir!,
            PI_TEST_EXTENSION_SKILL: contributedSkill,
          },
          encoding: "utf8",
          timeout: 30_000,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        assert.equal(result.status, 0, `pi failed:\n${output}`);
        const expected = skillPolicy === "allowlist"
          ? "skill:contributed-skill,skill:pinned-skill"
          : "skill:contributed-skill";
        assert.ok(output.split(/\r?\n/).includes(`SANDBOX_SKILLS=${expected}`), output);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

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
      const parts = [shellEscape(PI_EXECUTABLE), "--print", "--offline", "--no-session"];
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
      const parts = [shellEscape(PI_EXECUTABLE), "--print", "--offline", "--no-session"];
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
