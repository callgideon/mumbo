---
description: "The mumbo package group: deployment adapters that connect a running Web host to people's own tools and to the box edge pages beside it, and the agent that works a project's repository."
kind: "package-group"
---

# mumbo/ — connect a running host to the mumbo platform

English | [中文](README.zh.md)

## Summary

The mumbo family connects a running Web host to the platform around it: people's own tools, behind explicit authentication, and the pages the box edge serves beside the host. The adapters add no Session, tool, or storage behavior of their own; `superagent/` is the exception, a pinned copy of an agent that works one GitHub repository in its own Sessions. Each package README owns its contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`box-links/`](box-links/README.md) | Sidebar links from a box's Web page to the box home page and desktop live view |
| [`edge-member/`](edge-member/README.md) | Admits project members from the edge-signed header as non-owner principals with collaborator access |
| [`mcp/`](mcp/README.md) | Authenticated loopback MCP server through which allowlisted people drive the host's assistant Session |
| [`superagent/`](superagent/README.md) | Pinned copy of the upstream superagent: a proactive agent that turns authorized GitHub requests into Tickets and works each in its own Session |

-----

<a id="related-documentation"></a>
## Related documentation

- [MCP client](../mcp/README.md) — the opposite direction: external MCP servers exposed as native tools.
- [GitHub webhook adapter](../experimental/webhook-github/README.md) — another authenticated ingress on a dedicated listener.

<a id="dev-note"></a>
## Dev Note

None.
