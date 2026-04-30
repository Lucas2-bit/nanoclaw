---
name: pact-custody
description: Manage PACT custody transfers for multi-agent task delegation. Use when delegating work to another agent, checking for incoming task offers, or reporting task completion. Creates cryptographically signed custody chains visible on the dashboard.
---

# /pact-custody - PACT Custody Transfer Protocol

Use this to delegate tasks to other agents with full custody tracking. Every transfer creates a signed chain visible on the dashboard.

## Quick delegation (most common)

Delegate a task to another agent group:

bash
npx tsx pact-cli.ts delegate --agent main-agent --target-group target_folder --summary what you need done --task-type research


All CLI output is JSON. Parse it and act on the result. See /workspace/group/ventures/pact/src/bridge/pact-cli.ts for full usage.
