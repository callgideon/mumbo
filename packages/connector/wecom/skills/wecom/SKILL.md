---
name: wecom
description: "WeCom plugin: use WeCom through wecom-cli for contacts, messages, calendar, online meetings, to-dos, mail, WeDrive, docs, online sheets, smart sheets, smart docs, and slides. When the user mentions WeCom or these features, or gives a doc.weixin.qq.com or drive.weixin.qq.com link, load this skill first, then read the matching guide from the index."
---

# WeCom plugin

## DSH guidance

- Call this integration the WeCom plugin in user-facing replies. `wecom-cli` is installed by the WeCom plugin; run it by the absolute path that the current runtime context gives for it, not by name. Do not run `npm install -g @wecom/cli`, and do not install or upgrade `wecom-cli` any other way.
- The `wecom-cli` authorization is kept in the default configuration directory on this computer and is shared with `wecom-cli` in the user's own terminal.
- Before the first business command, read the `wecomcli-shared` guide and check the authorization as it describes. Where this section and that guide conflict, this section wins: its Step 1 version check needs no install or upgrade; the next item replaces its Step 3 initialization.
- When not authorized, first ask the user to open the WeCom plugin page in Plugins, click "Connect WeCom", and authorize by scanning the code with WeCom; check the authorization again after the user is done. Run `wecom-cli auth init --noninteractive` only when the user asks to finish the authorization in this conversation: it prints a scan link and a QR code and waits up to 5 minutes for the scan, so give the user the scan link. It writes credentials outside the workspace, and the scan is used up even when the save is denied: on the first attempt, set the Shell tool's `sandbox_permissions` to the narrowest mode that can write outside the workspace, with a `justification`.
- Run other `wecom-cli` commands in the existing sandbox; set `sandbox_permissions` only when a credential, cache, or log write is denied.
- When a command returns `errcode` 853004, that is `cli token expired`, `wecom-cli` has usually obtained a new token but could not write it to the configuration directory outside the workspace, so it returned the original error: the authorization is still valid and no upgrade is needed. Do not repeat the returned `help_message` to the user and do not ask the user to authorize again; set `sandbox_permissions` and `justification` and run the same command again. Only when the rerun still returns 853004, ask the user to authorize again on the WeCom plugin page.
- Never ask for or print credentials such as the Bot Secret or tokens.

## Guide index

- `wecomcli-shared`: the authorization check and the output constraints every guide shares (ID fields are not shown to the user); read it before the first `wecom-cli` business command.
- `wecomcli-contact`: search contacts by name, pinyin, English name, or alias, and look up userid, department, and position.
- `wecomcli-message`: list the conversations that can receive messages, and send text, Markdown, images, files, voice, or video to a direct or group chat.
- `wecomcli-calendar`: events without an online meeting link, meeting room booking, and free/busy; when the user only says "have a meeting" or "set up a meeting", ask first by the disambiguation flow of this guide or `wecomcli-meeting` instead of creating one directly.
- `wecomcli-meeting`: create, query, summarize, transcribe, update, and cancel online meetings that have a meeting number or join link; the same disambiguation rule applies.
- `wecomcli-todo`: create, complete, query and filter, and modify to-dos.
- `wecomcli-email`: send, receive, search, and read mail; use it to send event or meeting invitations only when the user explicitly mentions a mailbox or mail.
- `wecomcli-disk`: files in WeDrive (drive, shared spaces): list, search, metadata, location, upload, download, and rename; reading and writing the content of online documents belongs to the matching document guide.
- `wecomcli-media`: download a media file by media_id, or upload a local file to obtain a media_id; it only moves files and does not parse content.
- `wecomcli-doc-manage`: search documents of every kind (including recently viewed), rename them, and manage member permissions and join rules.
- `wecomcli-smartpage`: smart docs; use it when the user says only "document", "new document", "turn this into a document", or similar without naming a type, and to import .md as a document.
- `wecomcli-doc`: doc documents; use it only when the user explicitly says doc, docx, word, online document, or office document, or gives a `doc.weixin.qq.com/doc/` link.
- `wecomcli-smartsheet`: records, fields, views, charts, and styles of smart sheets; the default when the user does not explicitly say "online sheet".
- `wecomcli-sheet`: online sheets; use it when the user explicitly says "online sheet" or "excel sheet", wants to import CSV or Excel, or gives a `doc.weixin.qq.com/sheet/` link.
- `wecomcli-pptx`: generate or edit online slides, or import a local .ppt or .pptx as an online document; to only read the content of a local presentation, use `wecomcli-media` instead.

## Opening a guide

- A guide is not a skill of its own, so do not load it with the `skill` tool; open `skills/<name>/SKILL.md` under this skill's directory with the file read tool.
- A skill that a guide's body mentions by name (for example "the wecomcli-shared skill" or "use the wecomcli-meeting skill instead") is `skills/<name>/SKILL.md`; open it with the file read tool too.
- Relative paths in a guide (for example `references/...` or `../wecomcli-calendar/...`) are relative to that guide's own directory `skills/<name>/`.
