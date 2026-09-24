import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Model } from "@earendil-works/pi-ai/compat";
import { describeProfiles, loadProfilePolicy, resolveProfile } from "../pi-extension/subagents/profiles.ts";

const plain = {
  provider: "test",
  id: "plain",
  name: "Plain",
  api: "openai-completions",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 1024,
} as Model<any>;
const deep = { ...plain, id: "family/deep", name: "Deep", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } as Model<any>;
const registry = {
  find(provider: string, id: string): Model<any> | undefined {
    return [plain, deep].find((model) => model.provider === provider && model.id === id);
  },
};

function fixture(run: (paths: { root: string; repo: string; global: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "profile-policy-"));
  const repo = join(root, "repo");
  const global = join(root, "global");
  mkdirSync(repo);
  mkdirSync(global);
  try {
    run({ root, repo, global });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function profile(model: string, thinking: string, guidance = "Use for focused tasks.") {
  return { model, thinking, guidance };
}

function writePolicy(dir: string, profiles: Record<string, unknown>): void {
  writeFileSync(join(dir, "subagent-profiles.json"), JSON.stringify({ profiles }));
}

function writeProjectPolicy(repo: string, profiles: Record<string, unknown>): void {
  const dir = join(repo, ".pi");
  mkdirSync(dir, { recursive: true });
  writePolicy(dir, profiles);
}

describe("profile policy", () => {
  it("replaces the entire global list with a project policy", () => fixture(({ repo, global }) => {
    execFileSync("git", ["init", "-q", repo]);
    writePolicy(global, { global: profile("test/plain", "off") });
    writeProjectPolicy(repo, { project: profile("test/family/deep", "high") });
    const policy = loadProfilePolicy(repo, global);
    assert.deepEqual(Object.keys(policy.profiles), ["project"]);
    assert.equal(policy.source, join(realpathSync(repo), ".pi", "subagent-profiles.json"));
    assert.throws(() => resolveProfile(policy, "global", registry), /Unknown profile/);
  }));

  it("uses the global policy when the project has no file", () => fixture(({ repo, global }) => {
    execFileSync("git", ["init", "-q", repo]);
    writePolicy(global, { global: profile("test/plain", "off") });
    assert.deepEqual(Object.keys(loadProfilePolicy(repo, global).profiles), ["global"]);
  }));

  it("uses only the global policy outside a Git repository", () => fixture(({ repo, global }) => {
    writeProjectPolicy(repo, { local: profile("test/plain", "off") });
    writePolicy(global, { global: profile("test/plain", "off") });
    assert.deepEqual(Object.keys(loadProfilePolicy(repo, global).profiles), ["global"]);
  }));

  it("names both paths when neither policy file exists", () => fixture(({ repo, global }) => {
    execFileSync("git", ["init", "-q", repo]);
    assert.throws(() => loadProfilePolicy(repo, global), (error: Error) =>
      error.message.includes(join(repo, ".pi", "subagent-profiles.json")) &&
      error.message.includes(join(global, "subagent-profiles.json")));
  }));

  it("rejects an invalid project file instead of reading the global file", () => fixture(({ repo, global }) => {
    execFileSync("git", ["init", "-q", repo]);
    writePolicy(global, { global: profile("test/plain", "off") });
    mkdirSync(join(repo, ".pi"));
    writeFileSync(join(repo, ".pi", "subagent-profiles.json"), "{bad json");
    assert.throws(() => loadProfilePolicy(repo, global), /subagent-profiles\.json.*JSON|JSON.*subagent-profiles\.json/);
  }));

  it("rejects empty lists and unknown fields", () => fixture(({ repo, global }) => {
    writePolicy(global, {});
    assert.throws(() => loadProfilePolicy(repo, global), /at least one profile/);
    writeFileSync(join(global, "subagent-profiles.json"), JSON.stringify({ profiles: { quick: profile("test/plain", "off") }, typo: true }));
    assert.throws(() => loadProfilePolicy(repo, global), /typo/);
    writePolicy(global, { quick: { ...profile("test/plain", "off"), typo: true } });
    assert.throws(() => loadProfilePolicy(repo, global), /typo/);
  }));

  it("rejects empty names and guidance", () => fixture(({ repo, global }) => {
    writePolicy(global, { "": profile("test/plain", "off") });
    assert.throws(() => loadProfilePolicy(repo, global), /name/);
    writePolicy(global, { quick: profile("test/plain", "off", "  ") });
    assert.throws(() => loadProfilePolicy(repo, global), /guidance/);
  }));

  it("rejects unknown and unsupported model-specific thinking levels", () => fixture(({ repo, global }) => {
    writePolicy(global, { quick: profile("test/plain", "high") });
    const policy = loadProfilePolicy(repo, global);
    assert.throws(() => resolveProfile(policy, "quick", registry), /supports off/);
    writePolicy(global, { quick: profile("test/plain", "nonsense") });
    assert.throws(() => loadProfilePolicy(repo, global), /thinking/);
  }));

  it("accepts off for plain models and xhigh and max only when declared", () => fixture(({ repo, global }) => {
    writePolicy(global, {
      quick: profile("test/plain", "off"),
      deep: profile("test/family/deep", "xhigh"),
      hardest: profile("test/family/deep", "max"),
    });
    const policy = loadProfilePolicy(repo, global);
    assert.equal(resolveProfile(policy, "quick", registry).thinking, "off");
    assert.equal(resolveProfile(policy, "deep", registry).model.id, "family/deep");
    assert.equal(resolveProfile(policy, "hardest", registry).thinking, "max");
    assert.match(describeProfiles(policy), /quick.*focused/i);
    assert.match(describeProfiles(policy), /deep.*focused/i);
  }));

  it("accepts a one-character model ID", () => fixture(({ repo, global }) => {
    writePolicy(global, { quick: profile("test/x", "off") });
    assert.equal(loadProfilePolicy(repo, global).profiles.quick.model, "test/x");
  }));

  it("rejects a missing model and an unknown profile", () => fixture(({ repo, global }) => {
    writePolicy(global, { quick: profile("test/missing", "off") });
    const policy = loadProfilePolicy(repo, global);
    assert.throws(() => resolveProfile(policy, "quick", registry), /test\/missing/);
    assert.throws(() => resolveProfile(policy, "other", registry), /Unknown profile/);
  }));
});
