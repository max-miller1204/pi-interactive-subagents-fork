# Sub-agent model and effort profiles

## Goal

The delegating agent selects an approved model and thinking level for each Pi sub-agent task. It makes the choice at spawn time without asking the user to set either value. It uses a lower-cost profile for routine tasks and a stronger profile when the task needs it. Agent definitions continue to control the role, tools, and instructions.

## Scope

This extension launches Pi sub-agents only. Remove the Claude CLI launch path and its Claude-only hook, sentinel, transcript, status, and follow-up handling. Reject an agent definition with `cli: claude` with a clear error. Do not silently launch it through Pi. Keep references to Claude model names and `CLAUDE.md` where they apply to Pi models or project instructions.

## Configuration

The extension reads one profile file for the parent session's repository:

1. Use `<repository root>/.pi/subagent-profiles.json` if it exists.
2. Otherwise, use `<agent config directory>/subagent-profiles.json`. The agent config directory is `~/.pi/agent` by default and respects `PI_CODING_AGENT_DIR`.
3. If neither file exists, reject a Pi spawn and name both expected paths.

The repository root is the Git worktree root for the parent session's working directory. Outside a Git worktree, use the global file. A `cwd` argument for the child does not change the selected policy. A project file replaces the complete global list. Do not merge the two files. If the selected file is invalid or does not contain the requested profile, reject the spawn. Do not consult the other file.

The file contains a `profiles` object. Each key is a profile name. Each value has exactly these required fields:

```json
{
  "profiles": {
    "quick": {
      "model": "provider/model-id",
      "thinking": "low",
      "guidance": "Use for focused, routine tasks."
    },
    "deep": {
      "model": "provider/other-model-id",
      "thinking": "high",
      "guidance": "Use for complex tasks that need more analysis."
    }
  }
}
```

These model IDs illustrate the format. Users provide their own available models. Profile names and guidance are user-defined. A file must have at least one profile. Pi's thinking-level vocabulary includes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, but the supported set depends on the selected model. Reject empty names, empty guidance, extra fields, invalid levels, and malformed JSON. Resolve the model through Pi's model registry before launch. Reject an unavailable or ambiguous model. Check that the requested level is in `getSupportedThinkingLevels(resolvedModel)` before launch. Reject unsupported levels instead of allowing Pi to clamp them. No profile is built into the extension.

Load the selected policy once for a parent session. Re-evaluate it when the extension or session starts again. The tool description and spawn validation use the same loaded policy, so file edits do not silently change the choices during a session.

## Delegation flow

The `subagent` call must contain `agent`, `task`, and `profile`. The parent selects the profile based on the task and the guidance exposed by the extension. Replace the existing `model` tool argument with `profile`. Do not allow direct model or thinking overrides. Agent-definition `model` and `thinking` values do not override the selected profile. Existing role settings for tools, instructions, and other launch behavior remain in effect.

Make `profile` required in the tool schema. Remove the `model` tool argument. Reject unsupported `cli: claude` agent definitions before creating a pane.

The `subagent` tool description shows the active profile names and guidance. `subagents_list` shows the same list. This lets a parent select a profile without a separate discovery call. Reject an invalid choice before creating a pane or session artifact. Include the selected profile name and resolved model and thinking level in the spawn result where practical.

## Resume and nested delegation

Save the resolved model and thinking level in the existing Pi loadout snapshot. A resumed session uses these saved values, not the current profile file. This preserves the established resume sandbox. A nested Pi sub-agent follows the same selection rule when it delegates. It uses the profile file for its own parent session's repository. The existing `subagent_agents` restriction still limits which roles it can spawn.

## Failure behavior

Reject missing configuration, malformed configuration, unknown profiles, unavailable models, invalid or model-unsupported thinking levels, and `cli: claude` agent definitions with a clear error. Do not switch to another profile, an agent-definition model, a parent model, or the global list after a project file was selected. Do not create a pane when validation fails.

## Verification

Add unit tests for configuration precedence, full project replacement, global-only use, missing files, malformed files, invalid fields, unknown profiles, model resolution, and model-specific thinking support, including `off`, `xhigh`, and `max` where available. Test that the tool description and `subagents_list` show the selected policy. Test that spawns require a profile, reject the removed `model` argument, and pass the resolved model and thinking level into the loadout snapshot. Test that `cli: claude` definitions fail before pane creation. Remove Claude-only tests, plugin files, status branches, launch code, and documentation. Test nested delegation and resume after the profile file changes. Update the README and example configuration to describe the policy and the changed call shape.
