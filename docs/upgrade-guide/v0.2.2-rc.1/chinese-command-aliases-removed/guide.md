---
kind: upgrade-guide
description: "The Simplified Chinese aliases of the first-party slash commands are removed; only the English command names remain."
---

# Simplified Chinese slash-command aliases removed

## Change

`builtinCommandTokens` in `@deepseek-ai/dsh-commands/builtin` ([packages/interaction/commands/src/builtin.ts](../../../../packages/interaction/commands/src/builtin.ts)) now holds only English spellings, and `resolveCommand` no longer maps the Simplified Chinese aliases of the six first-party commands. The table identifies each removed alias by the Unicode code points that followed the `/`.

| Removed alias | Use instead |
| --- | --- |
| `U+76EE U+6807` | `/goal` |
| `U+8BA1 U+5212` | `/plan` |
| `U+53CD U+9988` | `/feedback` |
| `U+538B U+7F29` | `/compact` |
| `U+6743 U+9650` | `/permission` |
| `U+5BFC U+51FA` | `/export` |

A line that starts with a removed alias is no longer a command. In the Web and Desktop composer, the command source finds no match, so the line is sent to the agent as an ordinary message. SDK query text is also forwarded as a prompt, because `queryCommand` in [packages/sdk/server/src/query-input.ts](../../../../packages/sdk/server/src/query-input.ts) no longer recognizes it. A command that a plugin registers under one of these names still resolves by exact name.

Affected: composer users who typed the aliases, and scripts or SDK clients that send them.

## Migration

1. Replace each removed alias with its English command from the table and keep the arguments unchanged, so the former `plan` alias followed by a task becomes `/plan <task>`.
2. Search scripts, saved prompts, and SDK callers for a `/` followed by the code points above, and update every match.
3. Confirm the migration: send `/plan <task>` from the composer or the SDK and check that plan mode starts instead of the agent receiving the line as a message.
