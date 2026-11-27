---
name: tencent-meeting
description: "Tencent Meeting plugin: use Tencent Meeting through tmeet to create and query meetings, manage invitees, recordings and transcripts, smart minutes and Yuanbao minutes, meeting reports, in-meeting controls, and event subscriptions. When the user mentions Tencent Meeting, a meeting number, a meeting recording, or minutes, load this skill first, then read the tmeet-skill guide."
---

# Tencent Meeting plugin

## DSH guidance

- Call this integration the Tencent Meeting plugin in user-facing replies. `tmeet` is installed by the Tencent Meeting plugin; run it by the absolute path that the current runtime context gives for it, not by name. Do not run `npm install -g @tencentcloud/tmeet`, and do not install or upgrade `tmeet` any other way.
- The `tmeet` sign-in is kept in the default configuration directory on this computer and is shared with `tmeet` in the user's own terminal. Do not run `tmeet auth logout` unless the user asks.
- Before the first `tmeet` business command, read the `tmeet-skill` guide. Where this section and that guide conflict, this section wins: skip the install check in its installation and initialization section; skip its requirement to run `scripts/agent_init.py`, because DSH does not provide that script and `tmeet` does not depend on it.
- When a command reports that the user is not signed in or must sign in again (for example `user config is empty`, `user identity expired`, or `refresh token failed`), first ask the user to open the Tencent Meeting plugin page in Plugins, click "Connect Tencent Meeting", and finish the authorization; continue after the user is done. Run `tmeet auth login --no-browser` only when the user asks to finish the sign-in in this conversation: it prints the authorization link first and then waits up to 5 minutes, so give the user the complete link. It writes sign-in credentials outside the workspace, and the authorization is used up even when the save is denied: on the first attempt, set the Shell tool's `sandbox_permissions` to the narrowest mode that can write outside the workspace, with a `justification`.
- Run other `tmeet` commands in the existing sandbox; set `sandbox_permissions` only when a credential, lock, or log write is denied.
- Never ask for or print credentials such as the AccessToken or RefreshToken.

## Guide index

- `tmeet-skill`: the usage guide of the official Tencent Meeting CLI, covering every command, how to choose a query command, safety rules, operations that need a second confirmation from the user, and common errors; read it before the first `tmeet` business command. The parameters and examples of each module (meetings, recordings, reports, contacts, in-meeting controls, minutes, app information, events, and troubleshooting) are in its `references/`.

## Opening a guide

- A guide is not a skill of its own, so do not load it with the `skill` tool; open `skills/tmeet-skill/SKILL.md` under this skill's directory with the file read tool.
- Relative paths in the guide (for example `references/tmeet-meeting.md`) are relative to the guide's own directory `skills/tmeet-skill/`.
