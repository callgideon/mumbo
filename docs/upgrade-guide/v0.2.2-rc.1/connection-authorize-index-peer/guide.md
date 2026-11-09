---
kind: upgrade-guide
description: "Connection's authorizeIndex returns the admitted Peer instead of a boolean, and requestRejection refuses non-owner Peers."
---

# `authorizeIndex` returns the admitted Peer

English | [中文](guide.zh.md)

## Change

In `@deepseek-ai/dsh-client-connection`, `HostConnectionHandle.authorizeIndex(request, response)` returned `true` when the caller could serve the index and `false` after writing a redirect or 401. It now returns the `PeerScope` the index renders for, or `undefined` after writing the response. A request a registered authenticator admits returns that authenticator's non-owner Peer; an owner browser request returns `browserPeer`. `requestRejection(request)` now answers 403 to a request admitted as a non-owner Peer. Host plugins that call either method are affected.

## Migration

1. Replace boolean checks of `authorizeIndex`: `if (!ctx.connection.authorizeIndex(req, res)) return` becomes `const peer = ctx.connection.authorizeIndex(req, res); if (peer === undefined) return`, and `=== true` comparisons become `!== undefined`.
2. Render the index for the returned Peer, for example `ctx.webServer.renderIndex(html, peer)`, instead of `ctx.connection.browserPeer`.
3. A route that serves only the owner and bypasses Gateway access checks refuses `peer.principal.kind !== 'owner'` with 403, as the inspector DevTools route does.
4. Confirm with `pnpm run typecheck`; every remaining boolean use of the result fails to compile.
