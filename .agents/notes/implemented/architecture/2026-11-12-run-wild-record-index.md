# Agent Note: Run Wild record index

Status: implemented

## Problem

In Run Wild, Mumbo decides asks the person would otherwise answer, and each decision is a `runwild/decision` event in the Session that made it. The person needs one account of what ran without asking across every Session of their box, that the agent cannot change, that survives restarts and restores, and that later producers (browser and computer-use decisions in RW2) join without a format change. Session logs alone give none of that: they are per Session, and listing them all to find decisions reads every log.

## Decision

[`@mumbo/run-wild`](../../../../packages/mumbo/run-wild/README.md#record) keeps a box-wide record. A `session/event` listener in the Host copies each committed `runwild/decision` into one append-only JSONL file per UTC day under a configured root, which a person's box sets to `/root/.dsh/storages/runwild`. Each line is the event's data, its `summary` clipped to 2,000 characters, plus format version `v: 1`, `time`, `session`, `seq` and the root Session's id. Files are opened only to append, the directory is `0700` and the files `0600`, a partial last line gets a newline before the next one, and retention deletes whole day files older than `retentionDays` (90). Readers skip lines that are not v1 entries and read `kind` as an open string. The `mumbo-run-wild-record` service reads it for the owner-only view routes and for `@mumbo/mcp`'s `needs_you`.

The agent cannot change it because only the Host process writes it, through the listener; no tool, command or route writes. Under containment the Host runs as root, `/root/.dsh` is root's, the agent runs as its own user, the record is outside the model's file roots, and the agent cannot reach the Host's port. The box backup already takes `/root/.dsh`.

### The contract with RW2

Browser and computer-use decisions join by appending `runwild/decision` with `kind` `send`, `post`, `purchase` or `delete` for those categories, `target` the site's origin and the element, and `summary` what was written or bought, and `refusal` for a refusal. The listener copies any producer's decision, extra data fields pass through, the view's filters already name the four kinds, and an unknown kind is shown as "Other action" until its label is added. Each new kind needs its own same-version persistence record, because `RunWildDecisionKind` is a closed union in the Session format.

## Alternatives considered

**Storage-domain.** Its only facet, `kv`, offers whole-unit replacement or one document per record, and no append. One document per decision would be loaded in full at open. Its `backup-and-skip` policy for invalid records is meant for disposable derived data, and this record is the person's account of what ran in their name. Plain `node:fs` appends are the smallest correct tool.

**SQLite.** A database gives queries and atomic writes, but adds a schema with its own version and migrations for an append-only list read newest first. Day files make retention a file delete and keep the backup a plain copy.

**Reading Session logs on demand.** Listing decisions across Sessions would read every log, including archived ones, and a Session deleted by the person would take its decisions with it.

**One file without days.** Retention would rewrite the file, which an append-only record must never do.

## Consequences

The record and the Session log can differ by the last moments before a crash, because the record is written after the in-memory commit and the Session is flushed separately; no copy claims they match. A write failure is reported only until the Host restarts (`incomplete`), and lost lines are not rebuilt from Session logs. Before containment the agent runs as root and the record is only as protected as the box. In return the record is cheap to write, needs no migration, survives a Session's deletion, and lets RW2 add its decisions without touching the writer or the format.
