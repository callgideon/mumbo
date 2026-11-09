---
description: "The mumbo package group: what a per-user box deployment adds to a running Web host, from access for people's own tools to consent for browser writes."
kind: "package-group"
---

# mumbo/ — packages for the per-user box platform

English | [中文](README.zh.md)

## Summary

The mumbo family holds what a per-user box deployment adds to a running Web host: authenticated access for people's own tools, and consent for the assistant's actions with a person's signed-in accounts. Each package attaches to existing services and registers no model tools. Each package README owns its contract.

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
| [`browser-consent/`](browser-consent/README.md) | Reads free, writes ask: consent and an audit record for Playwright MCP browser writes in the person's own Chromium |
| [`mcp/`](mcp/README.md) | Authenticated loopback MCP server through which allowlisted people drive the host's assistant Session |

-----

<a id="related-documentation"></a>
## Related documentation

- [MCP client](../mcp/README.md) — the opposite direction: external MCP servers exposed as native tools.
- [GitHub webhook adapter](../experimental/webhook-github/README.md) — another authenticated ingress on a dedicated listener.

<a id="dev-note"></a>
## Dev Note

None.
