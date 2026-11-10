# Agent Note: Archive veto

Status: implemented

## Problem

Some Sessions must never be archived. A per-person box keeps one always-present assistant Session, `mumbo`, that runs the person's standing schedules. The Web's "stop and archive" passes `stopActivity`, and the Schedule plugin answers `workspace/session-stop` by deleting every schedule aimed at the Session. One accidental archive therefore drops the assistant's standing tasks silently, and unarchiving it later does not bring them back. Archive admission ([archive-stops-running-work](../feature/2026-09-21-archive-stops-running-session-work.md)) only asks what still runs; `stopActivity` skips that question by design, so nothing could refuse an archive outright.

## Decision

`@deepseek-ai/dsh-workspace` declares and dispatches a third archive event, `workspace/archive-veto`, in Cordis `bail` mode. `WorkspaceRegistry.archiveSession` dispatches it as the first step of every request, inside the registry's operation chain, with or without `stopActivity` and also for an id already archived. A listener returns a reason string to refuse, or `undefined` to leave the decision to the others; the first reason rejects the request with `WorkspaceArchiveVetoedError` (`sessionId`, `reason`) before the existence check, any write, any activity question, or any stop. A refused Session keeps its pin, its running work, and every schedule aimed at it.

`@deepseek-ai/dsh-workspace-controller` maps the error to `gateway/bad-request` with the reason in the message, as it maps a refused pin, so the Web treats the refusal as any other failed archive that is not about running work: the row button's archive logs a console warning. The stop-and-archive dialog is not reached, because it opens only for a `workspace/session-active` refusal and the veto runs before the activity check. The Client needs no change.

A plugin registers a veto with `ctx.on('workspace/archive-veto', …)`, which is a Cordis effect: it returns the disposer and is removed when the registering plugin unloads. The harness ships no listener. [`@mumbo/assistant`](../../../../packages/mumbo/assistant/README.md) registers one that refuses `mumbo`.

## Alternatives considered

**A `stopActivity` exemption.** Making the veto a `workspace/session-activity` answer would refuse only the plain archive; the stop-and-archive path skips that waterfall, and it is the path that deletes schedules.

**A registry method returning a disposer** (`workspaceRegistry.vetoArchive(fn)`). It needs its own listener set, its own disposal tests, and re-registration when the registry restarts. A Cordis event listener already has an owning fiber and a disposer, and it matches the two archive events beside it.

**An asynchronous `serial` dispatch.** The current listener decides from a fixed id. `bail` keeps the check synchronous, and a listener that needs I/O can still answer from state it keeps current.

**A per-Session "protected" flag in the workspace domain.** It would add durable state and a domain version for a rule one plugin owns; a deployment that removes the plugin would leave Sessions protected with no owner to clear the flag.

**A client-only guard** (hiding Archive for the assistant). The Remote endpoint, shortcuts, and any other caller would still archive it; the refusal belongs in the operation that archives.

## Consequences

Any plugin can make a Session unarchivable, so a misbehaving listener can block archiving for every Session. Its refusal names the listener's reason, which makes the cause visible. Archiving an already archived vetoed id now fails instead of resolving as a no-op; this only arises when a Session was archived before its veto was registered, and the owning plugin is expected to unarchive it, as `@mumbo/assistant` does at start.

The veto applies only to `archiveSession`. Deleting a Session's Workspace registration or its log is not covered.
