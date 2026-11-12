---
kind: upgrade-guide
description: "The `@mumbo/mcp` row now lets only reads and `todo_write` run unasked in turns that a project's report opened and requires the `permissionPresets` service, so a composition without the `permission` row no longer loads the door."
---

# `@mumbo/mcp` gates tools in report-started turns

## Change

In a turn that a project's report opened, [`@mumbo/mcp`](../../../../packages/mumbo/mcp/README.md#report-started-turns) lets only `read`, `read_image`, `glob`, `grep`, `get_goal`, `job_list`, `todo_write` and the browser reads that `@mumbo/browser-consent` classifies run unasked. Every other call asks the person, and under Run Wild it is refused with a note to the model; that includes the shells, `workflow`, `run_code`, file changes, subagent spawns, goal and schedule changes, computer use, MCP tools, `web_fetch` and `web_search`. Before, every tool ran unasked in Full access and in Run Wild whatever started the turn. The turn's origin is the message that opened it: a later message in the same turn, the person's included, does not change it, and the person's next message opens a turn of their own.

The plugin now injects `permissionPresets`, which the base bundle's `permission` row provides. A composition without that row leaves the `mumbo-mcp` row waiting for the service: the door serves no route and reports land nowhere. Affected: deployments that compose `@mumbo/mcp`, such as a person box's overlay; every Web profile already has the row.

## Migration

1. Keep the `permission` row (`@deepseek-ai/dsh-permission-presets`) enabled in every composition that mounts `@mumbo/mcp`.
2. Expect an approval card for each call other than a read in a turn that a project's report opened, and under Run Wild none of them runs in such a turn; the person's next message opens a turn in which they run as before.
3. Confirm the migration: start the deployment and check that the log has no pending `mumbo-mcp` row. Send a report through the door with `x-mumbo-report-project` and ask the assistant, in the report, to run a command; in a Run Wild Session its `bash` call answers `Error: bash did not run: this turn started with a project's report, …`.
