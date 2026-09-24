---
name: test-nested
description: Delegates one integration test task to test-echo
tools: read, bash
subagent_agents: test-echo
auto-exit: true
system-prompt: append
---

Follow the task exactly. Delegate to test-echo with the named profile. Wait for the child's result before finishing.
