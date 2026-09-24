# Sub-agent Model and Effort Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Pi sub-agent spawn use an approved, parent-selected model and thinking profile, and remove Claude CLI launch support.

**Architecture:** Load one strict profile policy per parent session from the Git worktree root or Pi agent directory. Validate the selected profile against Pi's model registry before pane creation, then save the resolved model and thinking level in the existing loadout snapshot. Remove the separate Claude CLI path so `profile` can be required in the tool schema.

**Tech Stack:** TypeScript, Pi extension API, TypeBox, Node test runner, tmux.

**Spec:** `docs/superpowers/specs/2026-09-23-subagent-model-effort-profiles-design.md`

## Global Constraints

- A project `.pi/subagent-profiles.json` replaces the whole global `<agent config directory>/subagent-profiles.json`; never merge them.
- The global agent directory respects `PI_CODING_AGENT_DIR`.
- Outside a Git worktree, use only the global policy.
- The parent's repository sets policy; the child's `cwd` does not.
- Missing or invalid policy, missing profile, missing model, and unsupported model-specific thinking level stop spawn before pane creation.
- Do not select a replacement profile or silently clamp thinking levels.
- `cli: claude` is an error, not an instruction to launch Pi.
- A resumed Pi session reuses its saved model and thinking level without reading the current policy.
- Keep existing role tool, skill, prompt, and `subagent_agents` restrictions.
- Keep comments, documentation, and application text short and direct. Do not use an em dash in new text.

## Review Focus

- Project file exists but lacks a profile that the global file has: reject the choice, not a global fallback (Task 2).
- Child `cwd` points at another worktree: retain the parent's policy (Task 3).
- A non-reasoning model requests `high`: reject before pane creation rather than let Pi clamp to `off` (Task 2 and Task 3).
- Multiple concurrent spawns share one session policy but keep independent profiles and snapshots (Task 3).
- A resume follows a changed or removed profile file: replay the stored loadout and do not consult the policy (Task 3).

## File Map

- `pi-extension/subagents/profiles.ts` (new): locate, parse, and validate a profile policy; resolve model-specific thinking choices.
- `pi-extension/subagents/index.ts`: remove Claude branches; require `profile`; keep one loaded policy per parent session; expose choices; pass resolved values to launch and snapshot.
- `pi-extension/subagents/status.ts`: remove Claude-only status source and transitions.
- `pi-extension/subagents/tmux.ts`: remove Claude sentinel-file poll route while preserving Pi exit-sidecar and screen polling.
- `pi-extension/subagents/plugin/hooks/hooks.json` and `pi-extension/subagents/plugin/hooks/on-stop.sh`: delete Claude-only plugin files.
- `test/profiles.test.ts` (new): policy parsing, precedence, and model support.
- `test/test.ts`: tool schema, launch helpers, status behavior, and extension registration tests.
- `test/integration/subagent-lifecycle.test.ts` and its fixtures: end-to-end profile selection, nested delegation, and snapshot resume.
- `README.md`, `subagent-profiles.json.example` (new), `agents/*.md`: document profile configuration and remove role-level model/thinking defaults from bundled agents. Keep `config.json.example` for existing status settings.
- `package.json` and `package-lock.json`: declare direct access to Pi's thinking-level helper and include policy tests in the unit test command.

### Task 1: Remove Claude CLI launch support

**Files:** Modify `pi-extension/subagents/index.ts`, `pi-extension/subagents/status.ts`, `pi-extension/subagents/tmux.ts`, `test/test.ts`; delete `pi-extension/subagents/plugin/hooks/hooks.json` and `pi-extension/subagents/plugin/hooks/on-stop.sh`.

**Interfaces:** Produce `requirePiAgent(defs: AgentDefaults): void` in `index.ts`. It throws for `defs.cli === "claude"`. Keep Pi polling via `pollForExit(surface, signal, { interval, sessionFile, onTick })`. Remove Claude-specific status sources and results.

- [ ] **Step 1: Add failing tests.** In `test/test.ts`, add a test of the exported `__test__.requirePiAgent({ cli: "claude" })` that expects `/cli: claude is not supported/`. Add an assertion that `__test__.requirePiAgent({ cli: undefined })` does not throw. Keep Pi status tests, and replace the existing Claude status test with a Pi starting-state check:

  ```ts
  assert.equal(createStatusState({ source: "pi", startTimeMs: 0 }).source, "pi");
  assert.throws(() => testApi.requirePiAgent({ cli: "claude" }), /cli: claude is not supported/);
  ```

- [ ] **Step 2: Run `npm test`.** Confirm the missing `requirePiAgent` test fails before edits to the launcher.
- [ ] **Step 3: Implement the removal.** Put `requirePiAgent` after `loadAgentDefaults`. Call it immediately after loading the agent definition and before any artifact or pane creation. Delete `resolveCliLaunchModel`, the Claude launcher branch, Claude sentinel and transcript helpers, Claude-only fields in `RunningSubagent` and result types, Claude-only completion/status/steering branches, and the Claude plugin files. Make the remaining launch path use Pi only. Remove `sentinelFile` from `pollForExit` options and its check. Keep a model-name check for Claude models in `contextWindowFor`, since that identifies a Pi model, not a Claude CLI process. Remove only tests that exercise removed Claude-only behavior; retain generic Claude model metadata tests.

  ```ts
  function requirePiAgent(defs: AgentDefaults): void {
    if (defs.cli === "claude") throw new Error("cli: claude is not supported; use a Pi agent");
  }
  ```

- [ ] **Step 4: Run `npm test` and `npm run test:integration`.** Check that Pi status, polling, spawning, and resume still pass. Fix any stale Claude-only branches instead of restoring the Claude path.
- [ ] **Step 5: Commit.** `git add pi-extension/subagents test/test.ts && git commit -m "refactor: remove Claude CLI subagent path"`.

### Task 2: Implement the profile policy as a focused module

**Files:** Create `pi-extension/subagents/profiles.ts`, `test/profiles.test.ts`; modify `package.json`, `package-lock.json`.

**Interfaces:** Import `Model` and `ModelThinkingLevel` from `@earendil-works/pi-ai/compat`. Export `type Profile = { model: string; thinking: ModelThinkingLevel; guidance: string }`, `type ProfilePolicy = { source: string; profiles: Readonly<Record<string, Profile>> }`, `loadProfilePolicy(parentCwd: string, agentDir: string): ProfilePolicy`, `describeProfiles(policy: ProfilePolicy): string`, and `resolveProfile(policy: ProfilePolicy, name: string, registry: { find(provider: string, id: string): Model<any> | undefined }): { name: string; model: Model<any>; thinking: ModelThinkingLevel }`. Use Pi's `getSupportedThinkingLevels(model)` from `@earendil-works/pi-ai/compat`. The coding-agent package does not export this helper, so add `@earendil-works/pi-ai` to peerDependencies and devDependencies at the repository's Pi version and update the lockfile. Require exact `provider/model-id` identity; split on the first `/` so model IDs may contain `/`.

- [ ] **Step 1: Write failing policy tests.** In `test/profiles.test.ts`, create isolated temporary Git repositories via `git init` and temporary global agent directories. Check project replacement, global-only selection, and no-Git global selection. Check missing policy, invalid JSON, empty `profiles`, extra fields, empty name or guidance, and unknown profile. Include the decisive precedence check:

  ```ts
  assert.deepEqual(Object.keys(loadProfilePolicy(repo, globalDir).profiles), ["project"]);
  assert.throws(() => resolveProfile(policy, "global", registry), /Unknown profile/);
  ```

- [ ] **Step 2: Add model checks to the failing tests.** Use registry fakes with one reasoning model and one non-reasoning model. Assert that `off` works for a non-reasoning model, `high` fails for that model, and `xhigh` or `max` works only when its `thinkingLevelMap` declares it. Assert `provider/model/id` is split at the first `/` and an unknown model fails. Test that `describeProfiles()` lists names and guidance, not just model IDs.
- [ ] **Step 3: Run `node scripts/run-tests.mjs --test test/profiles.test.ts`.** Confirm imports fail because the module does not exist.
- [ ] **Step 4: Implement `profiles.ts`.** Locate the repository root with `git rev-parse --show-toplevel` from `parentCwd`; use only the global path when Git reports that the directory is not a worktree. Propagate other Git errors. If the project path exists, read only that path. Parse strict JSON and check its root and every entry explicitly. Resolve the model with `registry.find(provider, modelId)`. Compare thinking against `getSupportedThinkingLevels(model)`, not a fixed four-level list. Throw descriptive errors with the selected file path, profile name, and supported levels. Do not import `index.ts` from this module. Extend the unit test script to include `test/profiles.test.ts`, without removing `test/test.ts`. Add the pi-ai peer and dev dependency, then update the lockfile with `npm install --package-lock-only`.

  ```ts
  const supported = getSupportedThinkingLevels(model);
  if (!supported.includes(profile.thinking)) {
    throw new Error(`Profile "${name}" requests ${profile.thinking}; ${model.provider}/${model.id} supports ${supported.join(", ")}`);
  }
  ```

- [ ] **Step 5: Run `npm test`.** Confirm every policy case and the old unit suite pass. Commit with `git add pi-extension/subagents/profiles.ts test/profiles.test.ts package.json package-lock.json && git commit -m "feat: validate subagent profile policy"`.

### Task 3: Wire the required profile into Pi spawning and resume

**Files:** Modify `pi-extension/subagents/index.ts`, `test/test.ts`, `test/integration/harness.ts`, `test/integration/subagent-lifecycle.test.ts`, and nested-spawn fixture agents as needed.

**Interfaces:** Consume `loadProfilePolicy`, `describeProfiles`, and `resolveProfile` from Task 2. Define `prepareProfileSpawn(policy: ProfilePolicy, name: string, registry: ModelRegistry): ResolvedProfile` as a thin validation wrapper. Define a session-scoped policy loaded at extension registration from `process.cwd()` and `getAgentConfigDir()`. Reuse it for every spawn in that parent process. A new child Pi process loads its own policy from its working directory. Pass the resolved `{ name, model, thinking }` to `launchSubagent`; its Pi loadout stores the exact `model.provider/model.id` and `thinking`. The existing `applySandboxToParts` resume path continues to use the loadout alone.

- [ ] **Step 1: Add failing schema and spawn tests.** In `test/test.ts`, assert that `subagent` parameters have required `agent`, `task`, and `profile`, and have no `model` property. Add a pure `prepareProfileSpawn(policy, profileName, registry)` helper to `index.ts` and test that a non-reasoning `high` profile throws before the helper returns launch inputs. Test concurrent `quick` and `deep` selections against the same immutable policy. For a child `cwd` in a second repository, assert the first repository's policy is used.

  ```ts
  assert.deepEqual([...tool.parameters.required].sort(), ["agent", "profile", "task"]);
  assert.equal("model" in tool.parameters.properties, false);
  ```

- [ ] **Step 2: Run `npm test`.** Confirm the schema and profile tests fail with the old tool contract.
- [ ] **Step 3: Update launch and tool registration.** Replace `SubagentParams.model` with required `profile`. Load policy at extension registration and make the description and validation use that same object. Update `launchSubagent` to call `prepareProfileSpawn` before writing task artifacts or creating panes, and use the exact resolved model in provider extension pinning and loadout creation. Register the tools even if policy loading fails, but retain and show that error, and reject every spawn without reading the global file again. Remove the old `resolveLaunchModel` and `resolveCliLaunchModel` helpers and tests. Do not read policy from the child's `cwd`. Keep `subagent_message` resume independent of the policy file. Include the selected profile name and resolved model and thinking level in the successful spawn acknowledgement.

  ```ts
  const choice = resolveProfile(policy, params.profile, ctx.modelRegistry);
  const effectiveModel = `${choice.model.provider}/${choice.model.id}`;
  const effectiveThinking = choice.thinking;
  ```

- [ ] **Step 4: Extend integration coverage.** In `test/integration/harness.ts`, initialize each test directory as a Git repository with `git init`, write `.pi/subagent-profiles.json` using `PI_TEST_MODEL` and `thinking: "off"`, and add `profile: "quick"` to every integration spawn task, including nested spawns. Require `PI_TEST_MODEL` for model-backed profile integration tests and skip those tests with a clear reason when it is absent. Spawn a Pi agent with a profile and read its `.loadout.json` to assert exact model and thinking. Spawn two profiles in parallel and check separate loadouts. Modify or remove the profile file after completion, then resume with `subagent_message` and assert the original model and thinking persist.
- [ ] **Step 5: Run `npm test` and `npm run test:integration`.** If integration needs credentials or tmux and the environment lacks them, report that limitation and run every available isolated test. Commit with `git add pi-extension/subagents/index.ts test && git commit -m "feat: select profile for each Pi subagent"`.

### Task 4: Show the active policy and update public documentation

**Files:** Modify `pi-extension/subagents/index.ts`, `test/test.ts`, `README.md`, `agents/scout.md`, `agents/worker.md`, `agents/researcher.md`; create `subagent-profiles.json.example`.

**Interfaces:** `subagent` tool description and prompt snippet include `describeProfiles(policy)` from Task 2. `subagents_list` result text and `details.profiles` expose the same loaded policy. The `model` and `thinking` keys in bundled agent files are removed; the profile policy owns those values for Pi launches.

- [ ] **Step 1: Add failing registration tests.** In `test/test.ts`, register the extension under isolated project and global policies. Assert the `subagent` description and prompt snippet contain active names and guidance, and that `subagents_list` returns `details.profiles` and matching text, even when no agent definitions are visible. Assert project precedence is visible in both places and that an invalid selected file produces a clear tool error instead of global choices.

  ```ts
  assert.match(subagentTool.description, /quick.*focused/i);
  assert.deepEqual(Object.keys(listResult.details.profiles), ["quick", "deep"]);
  ```

- [ ] **Step 2: Run `npm test`.** Confirm the discoverability tests fail.
- [ ] **Step 3: Update the tool text and list result.** Use one session policy object for the schema-facing description, prompt snippet, list result, and spawn resolution. For a missing or invalid policy, show its error in the tool description; `subagents_list` reports that error and spawn fails. Do not use a global file after a selected project file fails. Update the `/subagent` command message to tell the parent to select an active profile. Remove the agent-definition model badge from `subagents_list`, since it is not the launch model. Keep the agent list and role descriptions.

  ```ts
  const profileText = policyError ? `Profile policy error: ${policyError.message}` : describeProfiles(policy);
  const toolDescription = `${baseDescription}\nActive profiles:\n${profileText}`;
  if (policyError) throw policyError;
  return { content: [{ type: "text", text: `${lines.join("\n")}\n${profileText}` }], details: { agents: list, profiles: policy.profiles } };
  ```
- [ ] **Step 4: Update docs and examples.** Explain global and project paths, full replacement, ignored local `.pi` files, required `profile`, model-specific thinking checks, and resume snapshot behavior. Replace the existing `model` override examples. Remove Claude CLI launch and follow-up claims. Remove bundled agent `model` and `thinking` frontmatter. Keep `CLAUDE.md` references about working directories. Add a small profile example in README and a valid standalone `subagent-profiles.json.example` with illustrative model IDs; explain that users must replace those IDs with locally available models. Do not change `config.json.example`, which describes the existing status config.
- [ ] **Step 5: Run `npm test`, `npm run test:integration`, `git diff --check`, and a targeted `rg -n 'Claude CLI|cli: claude|model override' README.md pi-extension/subagents agents`.** Check that remaining references describe rejected config or Pi models. Commit with `git add pi-extension/subagents/index.ts test/test.ts README.md subagent-profiles.json.example agents && git commit -m "docs: explain Pi subagent profiles"`.

## Final review

- [ ] Run `npm test` and `npm run test:integration` again after all tasks. Record any integration test that cannot run and why.
- [ ] Run `git diff --check` and `git status --short`. Inspect remaining `claude` references to separate Pi-hosted Claude models and `CLAUDE.md` from obsolete CLI support.
- [ ] Request an independent whole-branch review against the spec. Fix verified findings and rerun affected tests before claiming completion.
