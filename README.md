# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux panes. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

**tmux-only fork.** See [Acknowledgements](#acknowledgements) for the upstream project, which also supports cmux, zellij, and WezTerm.

## How it works

`subagent()` returns immediately. The sub-agent runs in its own tmux pane — a right split off the parent pi pane, so pane creation never steals keyboard focus. A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  scout      active · bash 7m                 │
│ 00:45  scout-2    waiting 2m                       │
╰────────────────────────────────────────────────────╯
```

Spawn several in parallel — they run concurrently and steer results back independently as each finishes.

Panes are kept evenly sized: the extension re-applies an `even-horizontal` layout after every spawn and exit (debounced). The layout is a single constant, `SUBAGENT_TMUX_LAYOUT` in `pi-extension/subagents/tmux.ts` — change it to any named tmux layout (`main-vertical`, `tiled`, …).

Launch scripts atomically replace the new pane's startup shell, so slow shell initialization cannot consume or drop a subagent command.

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_message` | Message a sub-agent by name — steers it if running, resumes a finished Pi-backed session |
| `subagents_list` | List available agent definitions |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent> <task>` command for spawning directly.

### Spawning

```typescript
subagent({ agent: "scout", profile: "quick", task: "Analyze the auth module" });
subagent({ agent: "worker", profile: "deep", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `profile` | string | required | Approved model and thinking choice for this task |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Model and thinking profiles

Create `~/.pi/agent/subagent-profiles.json` to share approved choices across repositories. If you set `PI_CODING_AGENT_DIR`, put the file in that directory instead. Copy `subagent-profiles.json.example` as a starting point, then replace its model IDs with models available in your Pi installation.

A repository can put its own policy at `.pi/subagent-profiles.json`. The repository file replaces the complete global list. It does not merge with the global list. You can add the project file to `.gitignore` if you want to keep the policy local. Each person must then create their own copy. A child `cwd` override does not change which policy the parent uses for that spawn. Outside a Git repository, only the global file applies.

```json
{
  "profiles": {
    "quick": {
      "model": "provider/fast-model",
      "thinking": "low",
      "guidance": "Use for focused, routine tasks."
    },
    "deep": {
      "model": "provider/strong-model",
      "thinking": "high",
      "guidance": "Use for complex tasks."
    }
  }
}
```

The parent agent selects one profile on every spawn. The `subagent` tool and `subagents_list` show the active names and guidance. Pi checks whether each profile's model is available and whether that model supports the requested thinking level. Supported levels depend on the model and may include `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Pi does not change an unsupported level to another level. A missing, invalid, or unknown policy stops a spawn before pane creation. Policy file changes take effect when a new Pi session starts or when you reload Pi. An active session keeps its loaded choices.

The selected model and thinking level are saved in the child's loadout snapshot. Resume uses those saved values even if the policy file changes or is removed. Agent roles control tools and instructions. They do not select a model or thinking level. Direct `model` overrides are not supported.

### Messaging

`subagent_message` is addressed **by name only**. Pi-backed names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running:** the parent writes the message to the sub-agent's steer inbox (`<session>.steer/`).
  The sub-agent reads the inbox and handles the message at its next turn boundary.
  Newlines are kept.
  The call returns immediately, and the eventual completion still arrives as a steer message.
  Before a sub-agent exits, it closes its inbox.
  A message sent after that point is rejected with an error, so resend it after the result arrives.
  If a sub-agent stops before it reads a queued message (for example, its pane is closed), its result lists the message as not delivered.
- **Finished Pi session:** the session is resumed with the message as the follow-up task, like a fresh spawn: fire-and-forget, always autonomous, result steered back later. The resumed run reclaims its original name.

The message must contain at least one letter or digit.
A placeholder such as `"…"` is rejected.

Every Pi-backed spawn records name → session file in `artifacts/<sessionId>/subagent-registry.json`, so names stay addressable across pi restarts. A nested sub-agent that spawns children gets its own registry keyed by its own session id. Resume is refused with a clear error (listing known names) if the name is not registered, the session file is gone, the session predates extension-manifest snapshots, or a pinned extension or skill file is no longer installed.

**Resume replays the original sandbox.** At spawn time the fully resolved loadout — tool allowlist, exact tool/provider/control extension entry paths, skill policy and pinned skill files, model identity, thinking level, system prompt, spawn whitelist, cwd, and Pi config-directory path — is snapshotted to `<session>.loadout.json`. Resume replays those pinned entry paths without resolving strict skill or tool paths from the current parent. Extension discovery stays disabled. Normal skill discovery stays disabled for `none` and `allowlist`. Trusted pinned extensions can still contribute resources at runtime, as described in [Skill access control](#skill-access-control). Mutable request configuration read from the snapshotted agent directory, including `models.json`, authentication state, and provider/model headers, remains external to the sidecar and is not frozen across resume.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The session **stays open** (parked as `waiting`) instead of exiting; the parent is notified with the sub-agent's name, replies via `subagent_message({ name, message })`, and the reply arrives as the sub-agent's next turn. Parallel questions are supported — each waiting sub-agent has its own name.

If the reply arrives while the sub-agent is still mid-turn, it is absorbed into the current turn — either way the question is marked answered and the session exits normally when the work is done. If the parent never replies, the pane stays open until a human closes it. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Tools | Role |
| ----- | ----- | ---- |
| **scout** | `read`, `grep`, `find`, `ls` | Read-only codebase investigation |
| **researcher** | `web_search`, `web_fetch`, `safe_bash` | Web research with sources |
| **worker** | `read`, `write`, `edit`, `bash`, `web_search`, `web_fetch` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`) and carry their identity in the system prompt (`system-prompt: append`).

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
tools: read, edit, write, safe_bash, web_search
skill-policy: allowlist
available-skills: issue-triage, reviewed-pr
skills: issue-triage
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Any extension tool loaded in the parent can be used when Pi reports a loadable `sourceInfo.path`; `safe_bash` is bundled. Only the extensions backing listed tools are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. **Presence of this field grants the spawning toolset** (`subagent`, `subagent_message`, `subagents_list`) and restricts spawn targets to the list. Omit it and the agent cannot spawn at all |
| `skills` | string | Comma-separated skill names to load eagerly. With `allowlist`, each name must also be in `available-skills` |
| `skill-policy` | string | `all` (default), `allowlist`, or `none`. Controls normal Pi skill discovery and explicit skill files, not resources from trusted extensions. Strict policies are supported only for Pi sub-agents |
| `available-skills` | string | Comma-separated skills to pin and load explicitly when `skill-policy: allowlist` is set |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Decide exit at `agent_before_settle`; shut down at `agent_settled` (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name |
| `cli` | string | `cli: claude` is not supported and stops a spawn. Omit this field for Pi agents |

Agent files with `model` or `thinking` fields can still load, but profiles override those fields on every Pi spawn. Remove the fields from new agent definitions.

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

### auto-exit

With `auto-exit: true`, `agent_before_settle` decides whether the session can exit. `agent_settled` rechecks pending work and commits shutdown after Pi finishes retries and queued continuations. A low-level `agent_end` does not trigger auto-exit because Pi may retry or continue the run after it fires. The agent writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes at `agent_settled` once the run completes normally. An escape or abort leaves it open.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` instead of exiting when an `ask_question` is still unanswered, or when the agent's own child sub-agents are still running (a worker can stop after dispatching children and stays open until the last result returns). A final provider error after retries produces an error result for the parent.

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Access is **whitelist-only**. Every restricted sub-agent process is launched with `--no-extensions` (extension discovery disabled) and `--tools <allowlist>`; only the extensions backing the listed tools are loaded back in explicitly. There is no default toolset and no deny-list — an agent gets exactly what its frontmatter lists. The restriction survives resume via the versioned loadout snapshot.

For extension-backed tools, the launcher uses the canonical `sourceInfo.path` from `pi.getAllTools()` in the parent. This automatically supports npm/git Pi packages, global extensions, project extensions already trusted and loaded by the parent, renamed install directories, and one extension providing several tools. Built-in and SDK-inline pseudo-paths are never treated as loadable extension files. Unresolved or missing extension paths fail closed before launch instead of silently dropping tools or enabling global discovery.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn the agents in its `subagent_agents` list (enforced via `PI_SUBAGENT_ALLOWED`). There is no agentless spawn route, so a child can never escalate to a full-toolset profile by omitting its agent.

Child-only tools that are not present in the parent's tool inventory can use the compatibility hook `registerToolExtension(name, absolutePath)` on `globalThis.__pi_interactive_subagents`. The path must name an existing file. The original `~/.pi/agent/extensions/web-search`, `web-fetch`, and related pi-config locations remain deprecated fallbacks for compatibility.

Pi does not currently expose model-provider source paths. Extensions that call `pi.registerProvider(...)` must also call `globalThis.__pi_interactive_subagents.registerModelProviderExtension(providerName, absoluteExtensionPath)` before launching sub-agents. Explicitly registered provider ownership is pinned and fails closed if its backing file disappears. Without that public evidence, model metadata differences are treated as mutable external configuration rather than proof of extension ownership, so provider extensions must use this protocol. The snapshot pins model identity and explicitly registered extension-backed provider ownership, not mutable `models.json`, authentication, or request-header configuration.

## Skill access control

The default `skill-policy: all` keeps Pi's normal skill discovery. The `skills` field only loads named skills eagerly; it does not restrict which other skills the child can discover.

Use one of these strict policies to disable normal skill discovery:

- `allowlist` starts Pi with `--no-skills`, then loads each `available-skills` entry again with an exact `--skill <path>` argument.
- `none` starts Pi with `--no-skills` and does not pass any explicit skill file.

For `allowlist`, the launcher resolves each name from the parent's `pi.getCommands()` metadata and pins the reported skill file. Pi resolves discovered skill-name collisions before it returns this metadata, so the strict policy pins Pi's winning skill. Launch fails before pane creation if an `available-skills` entry is duplicated, the parent exposes no matching command or more than one matching command, a path is not an absolute existing file, two names resolve to one file, or an eager `skills` entry is not in `available-skills`. Resume replays these exact files and fails closed if one disappears. A legacy snapshot without skill fields keeps the former `all` behavior.

These policies control normal Pi skill discovery and the skill files that the launcher loads explicitly. Trusted pinned tool and model-provider extensions can add other skills through `resources_discover`, including with `none` or `allowlist`. These skills can appear in the child's catalog and invocation commands on launch and resume. Extension resource contributions are not pinned by the skill manifest.

Extensions are executable trusted code. They can also alter prompts or register commands. Skill policy is not a sandbox against these extensions, or a file-system sandbox for agents that have file-reading tools. Only load extensions that you trust with the child's context and permissions.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific context applies. With the default `all` policy, role-specific skills are also discovered. With `allowlist`, a role-specific skill loaded explicitly by the launcher must already be present in the parent's command metadata so the launcher can pin its exact file. Trusted extensions can contribute other skills at runtime. Restricted agents still use `--no-extensions`; a role-specific extension tool must already be represented by parent provenance or the explicit compatibility registration hook:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", profile: "deep", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Status widget & configuration

The widget tracks each sub-agent from a runtime activity snapshot written by the child: `starting`, `active` (turn/provider/tool work), `waiting` (open for input or another stage), `stalled` (no valid snapshot for too long), or `running` (fallback). Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`.

Status display is configured via `config.json` in the extension directory (copy `config.json.example`; it's gitignored):

```json
{
  "status": { "enabled": true }
}
```

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- [tmux](https://github.com/tmux/tmux)

```bash
tmux new -A -s pi 'pi'
```

Integration tests use the global `pi` executable on `PATH`, not the repository's local Pi dependency. Set `PI_TEST_MODEL` to an authenticated `provider/model-id` to run model-backed lifecycle tests. Without it, those tests are skipped.

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
