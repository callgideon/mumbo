---
kind: upgrade-guide
description: "The `@mumbo/mcp` row now gates the shells, `workflow`, `run_code`, `schedule_create` and `schedule_edit` in turns that a project's report started and requires the `permissionPresets` service, so a composition without the `permission` row no longer loads the door."
---

# `@mumbo/mcp` gates commands in report-started turns

## Change

While the newest message that a person or a project sent to a Session is a project's report, [`@mumbo/mcp`](../../../../packages/mumbo/mcp/README.md#report-started-turns) makes every call to `bash`, `pwsh`, `workflow`, `run_code`, `schedule_create` or `schedule_edit` ask the person, and under Run Wild refuses it with a note to the model. Before, these tools ran unasked in Full access and in Run Wild whatever started the turn. A message from the person in the browser or through the door, or a scheduled task's message, ends the gate.

The plugin now injects `permissionPresets`, which the base bundle's `permission` row provides. A composition without that row leaves the `mumbo-mcp` row waiting for the service: the door serves no route and reports land nowhere. Affected: deployments that compose `@mumbo/mcp`, such as a person box's overlay; every Web profile already has the row.

## Migration

1. Keep the `permission` row (`@deepseek-ai/dsh-permission-presets`) enabled in every composition that mounts `@mumbo/mcp`.
2. Expect an approval card for each command, program or schedule change in a turn that a project's report started, and under Run Wild none of them runs in such a turn; the person's next message lifts the gate.
3. Confirm the migration: start the deployment and check that the log has no pending `mumbo-mcp` row. Send a report through the door with `x-mumbo-report-project` and ask the assistant, in the report, to run a command; in a Run Wild Session its `bash` call answers `Error: bash did not run: the newest message in this Session is a project's report, …`.
