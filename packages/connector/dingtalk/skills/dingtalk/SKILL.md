---
name: dingtalk
description: "DingTalk plugin: use DingTalk through dws for calendar and meeting rooms, to-dos, group chats and bots, contacts, docs, DingTalk Drive, wikis, AI tables, mail, AI minutes, approvals, attendance, reports, whiteboards, AI search, and event listening. When the user mentions DingTalk or these features, or gives a DingTalk link such as alidocs.dingtalk.com, load this skill first, then read the matching guide from the index."
---

# DingTalk plugin

## DSH guidance

- Call this integration the DingTalk plugin in user-facing replies. `dws` is downloaded by the DingTalk plugin; run it by the absolute path that the current runtime context gives for it, not by name. Do not install or upgrade `dws` with npm, the official install script, or `dws upgrade`, and do not run `dws skill setup` to install skills into an Agent directory.
- The `dws` sign-in is kept in `~/.dws` and the system keychain on this computer and is shared with `dws` in the user's own terminal. Do not run `dws auth logout` unless the user asks.
- Where this section and a guide conflict, this section wins.
- Check the sign-in state only with `dws auth status --readonly --format json`, also when a guide asks you to run `dws auth status`. A check without `--readonly` writes `~/.dws`, and when the file sandbox denies that write it reports a signed-in account as signed out, so it is not evidence.
- Only when that check returns `authenticated: false`, or a command states that the sign-in is no longer valid, ask the user to open the DingTalk plugin page in Plugins, click "Connect DingTalk", and finish the authorization; continue after the user is done. Run `dws auth login --no-browser` only when the user asks to finish the sign-in in this conversation: it prints the authorization link on stderr and then waits up to 6 minutes, so give the user the complete link; the authorization callback address is `127.0.0.1`, so the user must open the link in a browser on this computer. It writes credentials outside the workspace, and the authorization is used up even when the save is denied: on the first attempt, set the Shell tool's `sandbox_permissions` to the narrowest mode that can write outside the workspace, with a `justification`.
- Run other `dws` commands in the existing sandbox first. Every command that reads or writes DingTalk data writes a lock file under `~/.dws`: when a command fails because it cannot open the lock file or cannot write credentials, cache, or logs, the file sandbox denied the write and the account is not signed out, so do not ask the user to reconnect; set `sandbox_permissions` and `justification` and run the same command again. After one such denial in this conversation, set them on the first attempt of every later command that reads or writes DingTalk data.
- When the sign-in or a command reports that the organization has not enabled CLI data access, tell the user that an organization administrator must enable CLI access in the DingTalk developer console, or that the user can request it from the administrator on the authorization page.
- Never ask for or print credentials such as tokens, refresh tokens, or the Client Secret.

## Guide index

- `dingtalk-shared`: the global execution contract and cross-product navigation; read it first for general DingTalk requests, cross-product flows, or when the link type or product boundary is unclear.
- `dingtalk-calendar`: events, meeting rooms, free/busy, and attendees; starting and controlling video meetings belongs to `dingtalk-misc`.
- `dingtalk-todo`: create, assign, complete, and query to-dos, including recurring to-dos.
- `dingtalk-chat`: send, receive, and search group chats and messages, create and manage groups, bots and Webhooks, and group files.
- `dingtalk-contact`: exact contact lookups: details, department, and position by userId, and a user by full phone number; finding people by an approximate name belongs to `dingtalk-aisearch`.
- `dingtalk-aisearch`: AI search: find people by meaning, and search across sources by topic or activity.
- `dingtalk-doc`: DingTalk online documents: find, read and write, blocks, comments, attachments, import and export, versions, templates, permissions, and sharing.
- `dingtalk-drive`: files in DingTalk Drive and document spaces: find, recent documents, upload and download, move, rename, delete, permissions, and syncing with a local folder.
- `dingtalk-wiki`: wikis and spaces: create, find, members, organizing nodes inside a wiki, and activity.
- `dingtalk-aitable`: AI tables (multidimensional tables): create tables, records and fields, filters, sorting and formulas, import and export, dashboards, and data sync.
- `dingtalk-mail`: DingTalk Mail: send, receive, search, reply, forward, and attachments.
- `dingtalk-minutes`: AI minutes: summaries, transcripts, action items, recordings, mind maps, and sharing permissions.
- `dingtalk-event`: long-connection listening for events such as personal messages, approvals, call invitations, to-dos, and interactive cards.
- `dingtalk-aicard`: create, edit, and validate DingTalk AI card (A2UI) JSON offline.
- `dingtalk-tag`: create, query, modify, publish, and delete digital employees.
- `dingtalk-misc`: a collection of less-used products: approvals, smart contracts, attendance, live streams, DING messages, the open platform, Agoal goals, daily and weekly reports, spreadsheets, whiteboards, the skill market, the organization brain, Markdown and HTML files, action authorization, and multi-organization profiles.

## Opening a guide

- A guide is not a skill of its own, so do not load it with the `skill` tool; open `guides/<name>/SKILL.md` under this skill's directory with the file read tool.
- A skill that a guide's body mentions by name (for example "go through dingtalk-misc" or "read dingtalk-shared first") is `guides/<name>/SKILL.md`; open it with the file read tool too.
- Relative paths in a guide (for example `references/...` or `../dingtalk-shared/SKILL.md`) are relative to that guide's own directory `guides/<name>/`. Its scripts (for example `scripts/calendar_today_agenda.py`) are in that directory too; run them by their full path.
