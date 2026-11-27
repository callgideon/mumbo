---
kind: upgrade-guide
description: "WebServer refuses non-owner Peers on registrations without `access: 'non-owner'`, Connection's `authenticators`, `admitIndex`, and `admitConnection` are removed for authentication Providers with a `precedence` option, and the working-directory chooser APIs are removed."
---

# Non-owner route access is opt-in; Connection authenticators and the directory chooser are removed

## Change

[WebServer](../../../../packages/host/webserver/README.md) answers 403 to an admitted Peer whose principal is not the owner on every route, fallback, and upgrade that does not declare `access: 'non-owner'`. Before, a route served every Peer Connection admitted, and each handler refused non-owners itself.

Connection removes `ctx.connection.authenticators`, `admitIndex()`, and `admitConnection()`. A plugin registers an [authentication Provider](../../../../packages/client/connection/README.md#browser-authentication-and-request-trust) with `ctx.connection.authentication.register(provider, options?)`; the new `{ precedence: 'first' }` option places it ahead of every Provider registered so far. WebServer passes the admitted Peer to the handler or resource.

[Working directory](../../../../packages/session/working-directory/README.md) removes `WorkingDirectoryService.chooser()`, `resolveModelDirectory()`, and the chooser parameter of `set()`; `SubagentStartRequest.cwdChooser` is removed with them. A directory records no chooser, and the filesystem provider's roots alone decide whether a directory is usable.

Affected: plugins that register Web routes a project member must reach, plugins that admit non-owner principals, and callers of the removed working-directory and subagent fields.

## Migration

1. On each `ctx.webServer.register()`, `registerUpgrade()`, or `registerFallback()` that a non-owner must reach, add `access: 'non-owner'` and decide in the handler what each `peer.principal` may do. Leave every other registration unchanged; it stays owner-only.
2. Replace `ctx.connection.authenticators.register(fn)` with `ctx.connection.authentication.register({ authenticate: fn })`, and inject `connection.authentication`. Pass `{ precedence: 'first' }` only when a request carrying this credential beside another must be admitted as this credential's Peer.
3. Replace `admitIndex()` and `admitConnection()` calls with the Peer WebServer passes to the handler, or `ctx.connection.admit(request)` in an adapter outside WebServer.
4. Remove the chooser argument from `workingDirectory.set(agent, path, signal?)` and delete `chooser()` and `resolveModelDirectory()` calls; resolve a model-supplied path through the filesystem provider before calling `set()`.
5. Remove `cwdChooser` from `SubagentStartRequest` values.
6. Confirm the migration: run `pnpm run typecheck`, then request a migrated route as a project member and as the owner. The member receives 403 on a route without `access` and the handler's answer on a route with it.
