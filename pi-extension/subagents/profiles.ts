import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai/compat";

export type Profile = { model: string; thinking: ModelThinkingLevel; guidance: string };
export type ProfilePolicy = { source: string; profiles: Readonly<Record<string, Profile>> };
export type ModelRegistry = { find(provider: string, id: string): Model<any> | undefined };
export type ResolvedProfile = { name: string; model: Model<any>; thinking: ModelThinkingLevel };

const LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) throw new Error(`${context}: unknown field "${key}"`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw new Error(`${context}: missing field "${key}"`);
  }
}

function parsePolicy(source: string): ProfilePolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(source, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}: ${String(error)}`);
  }
  if (!record(parsed)) throw new Error(`${source}: expected an object`);
  onlyKeys(parsed, ["profiles"], source);
  if (!record(parsed.profiles) || Object.keys(parsed.profiles).length === 0) {
    throw new Error(`${source}: expected at least one profile`);
  }
  const profiles: Record<string, Profile> = Object.create(null);
  for (const [name, value] of Object.entries(parsed.profiles)) {
    if (!name.trim()) throw new Error(`${source}: profile name must not be empty`);
    if (!record(value)) throw new Error(`${source}: profile "${name}" must be an object`);
    onlyKeys(value, ["model", "thinking", "guidance"], `${source}: profile "${name}"`);
    if (typeof value.model !== "string" || !/^[^/\s]+\/\S+$/.test(value.model)) {
      throw new Error(`${source}: profile "${name}" needs a provider/model-id`);
    }
    if (typeof value.thinking !== "string" || !LEVELS.includes(value.thinking)) {
      throw new Error(`${source}: profile "${name}" has an invalid thinking level`);
    }
    if (typeof value.guidance !== "string" || !value.guidance.trim()) {
      throw new Error(`${source}: profile "${name}" needs guidance`);
    }
    profiles[name] = { model: value.model, thinking: value.thinking as ModelThinkingLevel, guidance: value.guidance };
  }
  return { source, profiles };
}

export function loadProfilePolicy(parentCwd: string, agentDir: string): ProfilePolicy {
  const globalPath = join(agentDir, "subagent-profiles.json");
  let projectPath: string | undefined;
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: parentCwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    projectPath = join(root, ".pi", "subagent-profiles.json");
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() ?? "";
    if (!stderr.includes("not a git repository")) throw error;
  }
  if (projectPath && existsSync(projectPath)) return parsePolicy(projectPath);
  if (existsSync(globalPath)) return parsePolicy(globalPath);
  throw new Error(`No subagent profile policy found. Checked ${projectPath ?? "(outside a Git repository)"} and ${globalPath}`);
}

export function describeProfiles(policy: ProfilePolicy): string {
  return Object.entries(policy.profiles)
    .map(([name, profile]) => `${name}: ${profile.guidance} (${profile.model}, ${profile.thinking})`)
    .join("\n");
}

export function resolveProfile(policy: ProfilePolicy, name: string, registry: ModelRegistry): ResolvedProfile {
  if (!Object.hasOwn(policy.profiles, name)) {
    throw new Error(`Unknown profile "${name}" in ${policy.source}. Available: ${Object.keys(policy.profiles).join(", ")}`);
  }
  const profile = policy.profiles[name];
  const separator = profile.model.indexOf("/");
  const provider = profile.model.slice(0, separator);
  const id = profile.model.slice(separator + 1);
  const model = registry.find(provider, id);
  if (!model) throw new Error(`Profile "${name}" in ${policy.source} uses unavailable model ${profile.model}`);
  const supported = getSupportedThinkingLevels(model);
  if (!supported.includes(profile.thinking)) {
    throw new Error(`Profile "${name}" requests ${profile.thinking}; ${model.provider}/${model.id} supports ${supported.join(", ")}`);
  }
  return { name, model, thinking: profile.thinking };
}
