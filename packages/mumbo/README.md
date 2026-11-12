---
description: "The mumbo package group: what a per-user box deployment adds to a running Web host, from access for people's own tools and the box edge pages beside it to consent for browser writes, and the agent that works a project's repository."
kind: "package-group"
---

# mumbo/ — packages for the per-user box platform

## Summary

The mumbo family holds what a per-user box deployment adds to a running Web host: authenticated access for people's own tools, the pages the box edge serves beside the host, project members, consent for the assistant's actions with a person's signed-in accounts, and Run Wild, the mode in which the assistant decides instead of asking. Each package attaches to existing services and registers no model tools; `superagent/` is the exception, a pinned copy of an agent that works one GitHub repository in its own Sessions. Each package README owns its contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package owns one deployment concern.

| Package | Role |
|---|---|
| [`assistant/`](assistant/README.md) | Mumbo, the person's always-present assistant Session: first in the sidebar's navigation band, never archived, given its own instructions, and opened first |
| [`box-links/`](box-links/README.md) | Sidebar links from a box's Web page to the box home page and desktop live view, and the right-panel Desktop and Browser tabs that show the live view, with Take over and Hand back in the Browser tab |
| [`browser-consent/`](browser-consent/README.md) | Reads free, writes ask, denied pages never: consent and an audit record for Playwright MCP browser writes in the person's own Chromium, consent for desktop input, and the person's takeover of the browser |
| [`edge-member/`](edge-member/README.md) | Admits project members from the edge-signed header as non-owner principals with collaborator access |
| [`mcp/`](mcp/README.md) | Authenticated loopback MCP server through which allowlisted people drive the host's assistant Session, and the gate that lets only reads run unasked in turns a project's report started |
| [`run-wild/`](run-wild/README.md) | Run Wild, the permission preset in which the assistant decides tool approvals, plan reviews and questions instead of asking the person, with an audit record of each decision |
| [`superagent/`](superagent/README.md) | Pinned copy of the upstream superagent: a proactive agent that turns authorized GitHub requests into Tickets and works each in its own Session |

-----

<a id="related-documentation"></a>
## Related documentation

- [MCP client](../mcp/README.md) — the opposite direction: external MCP servers exposed as native tools.
- [GitHub webhook adapter](../experimental/webhook-github/README.md) — another authenticated ingress on a dedicated listener.

<a id="dev-note"></a>
## Dev Note

None.
