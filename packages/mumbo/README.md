---
description: "The mumbo package group: deployment adapters that let people reach a running Web host from their own tools."
kind: "package-group"
---

# mumbo/ — reach a running host from your own tools

English | [中文](README.zh.md)

## Summary

The mumbo family exposes what a running Web host already does to people's own tools, behind explicit authentication. Its packages add no Session, tool, or storage behavior of their own; they adapt existing services to an outside protocol. Each package README owns its contract.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Each package adapts one outside protocol.

| Package | Role |
|---|---|
| [`mcp/`](mcp/README.md) | Authenticated loopback MCP server through which allowlisted people drive the host's assistant Session |

-----

<a id="related-documentation"></a>
## Related documentation

- [MCP client](../mcp/README.md) — the opposite direction: external MCP servers exposed as native tools.
- [GitHub webhook adapter](../experimental/webhook-github/README.md) — another authenticated ingress on a dedicated listener.

<a id="dev-note"></a>
## Dev Note

None.
