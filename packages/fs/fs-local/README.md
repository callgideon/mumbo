---
description: "The host-filesystem backend for ctx.fs for deployments and maintainers choosing or debugging local file access."
kind: "package-reference"
---

# @deepseek-ai/dsh-fs-local

## Summary

Use `dsh-fs-local` to read, list, watch, write, edit, patch, delete, and move files on the host. Relative paths use a configurable base; absolute paths and parent traversal remain unrestricted unless `modelRoots` and `readOnlyRoots` confine the model's paths. Aliases share one identity. Optional guards reject stale versions, and text publication preserves permissions. Moves can also apply hunks and report a published destination separately from source removal. Use `fs-sandbox` when mutations need confinement.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this backend when a composition needs `ctx.fs` backed by the real host filesystem and accepts a process-local implementation. The common path is explicit: load the backend, give it a base directory, and the model-facing tools (`dsh-tool-fs`) or your own plugins can read, write, and edit files.

### When to choose it

Choose `fs-local` for ordinary host-file access in a single process. Choose [`fs-sandbox`](../fs-sandbox/README.md) when a session's writes and edits must be confined to its workspace and temp roots — it extends this backend and adds only the mode fence. `config.cwd` is a resolution default, not a containment boundary: absolute paths and `..` escape it.

### Minimal configuration

Load the backend with a base directory; relative paths resolve against it, and absolute paths ignore it. A requested path that is `~` or starts with `~/` (or `~\` on Windows) begins at the host user's home directory; `~user`, later `~` segments, and directory entry names stay literal. A relative base is anchored to the provider process working directory, and display paths remain absolute. On POSIX, resolution follows filesystem semantics before lexical normalization: `symlink/..` reaches the parent of the link target, including when the final file does not exist yet. Directory listings preserve the same physical traversal in displayed child paths. Windows retains native drive-relative normalization.

```yaml
- name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: /absolute/path/to/workspace
```

| Field | Default | Meaning |
|---|---|---|
| `cwd` | `process.cwd()` | Base directory for relative paths |
| `diffBasisMaxBytes` | `10 MiB` | UTF-8 byte limit per overwrite-diff side; larger overwrites return `before: null` |
| `modelRoots` | unset | Existing absolute directories the model's file tools are confined to; see [Confining model paths](#confining-model-paths) |
| `readOnlyRoots` | unset | Existing absolute directories the model's file tools may also read but never change; requires `modelRoots`; see [Read-only roots](#read-only-roots) |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-fs-local) is the exhaustive source for every accepted field and its JSDoc.

<a id="confining-model-paths"></a>
### Confining model paths

Set `modelRoots` to confine the model's file tools to an allowlist of directories, for example the workspace and the agent user's home in a contained box. Keep shared temporary directories such as `/tmp` out: the file tools run as this process, so every file under a root is readable to them whoever owns it. The provider requires Linux, canonicalizes each root at load, and fails loudly when a root is not absolute, missing, or not a directory, when the list is empty, or when a root contains this process's temporary directory.

```yaml
- name: '@deepseek-ai/dsh-fs-local'
  config:
    modelRoots: [/root/projects, /home/agent]
```

`resolveModelPath`, which every model-facing tool uses for a model-supplied path, resolves the path one name at a time from `/`, following symbolic links and `..` as the kernel does, and refuses with `FS_OUTSIDE_ROOTS` before it examines any name that is neither under a root nor on the way to one (an ancestor of a root by its configured or real spelling), and any path whose walk ends outside every root: absolute paths such as `/proc/self/environ`, `..` traversal out of a root, and symbolic links to files or directories outside, including a final link whose target does not exist. A path that does not exist yet ends at its first missing name with the rest appended, so a new file under a linked parent is refused, and a dangling link inside the roots leads to the file a write through it creates. Every `resolve` call, including harness readers such as instruction and skill discovery and the Files panel, also refuses a path written under a root whose real path leaves the roots, because the model can plant links under its roots. Other harness paths outside the roots resolve as before. A reader the person drives directly, such as the Files panel, passes `unconfined: true` to `resolve` and keeps following such links. Because the walk stops at the first name outside the roots, whether a path exists outside them, what it is, or where a `..` from it would lead never changes the outcome: `link/<name>/../../projects/file` through a link out of the roots and a final link to a missing or an existing outside file all get the same refusal. One walk decides both where the path leads and how it fails. It holds a descriptor of each directory it enters and examines the next name only within that directory, through `/proc/self/fd`, never by a path the kernel would walk again, so a link the model's shell repoints, or a directory it swaps for a link between two steps, changes only which way the walk goes, never what it reveals about names outside. A name that changes between being examined and being entered is examined again, at most 40 times. `..` inside the roots and on the way to them keeps its physical meaning. A listing of a directory under a root reports a child whose real path leaves every root as an opaque `other` entry, with no size or version and a target that is its in-root path, which no read accepts.

With model roots, every read and listing opens its target once (`O_NONBLOCK`, so a FIFO cannot block) and accepts the descriptor only when `/proc/self/fd` reports the resolved real path; a link swapped in after resolution is refused with `FS_OUTSIDE_ROOTS` when the opened file lies outside the roots and `FS_STALE_VERSION` otherwise, and listings read names and children through the accepted descriptor. Under a run-as provider, a regular file with more than one hard link that the run-as user does not own is refused too: a hard link has no path of its own for the roots check. Changes are never made by this process on the model's behalf when the mounted subprocess provider reports a [child identity](../../subprocess/subprocess/README.md): each write, edit, patch, delete, move, and directory creation runs in a one-shot helper process (`mutation-helper`) the provider starts as that identity, so the kernel judges every path component with its permissions; the helper's output is decoded strictly and its failures keep their codes. With model roots and no subprocess provider mounted, every change is refused rather than made by this process. Without a child identity, changes run in this process as before. The helper runs `node` on this package's installed files with `/` as its working directory, so the run-as user must be able to read the dsh install (its source or `lib/` files, `node_modules`, and `tsconfig.base.json` when it runs from source) and must have a usable `TMPDIR` of its own; otherwise every change fails with `FS_IO_ERROR`. The run-as provider also requires `fs.protected_hardlinks=1`, so the run-as user cannot hard-link a file it may not write into a directory the model reads. The [agent containment Agent Note](../../../.agents/notes/implemented/architecture/2026-11-10-agent-containment-run-as-and-model-roots.md) records the decision.

<a id="read-only-roots"></a>
#### Read-only roots

Set `readOnlyRoots` beside `modelRoots` to the harness directories the model is told to read, such as the attachment store, the skill directories, and the spill directories whose paths results name. Paths under them resolve, read, and list exactly as under a model root, through the same descriptor check and opaque listing entries. Every change whose path lies under one, by its real or its written path, is refused with `FS_OUTSIDE_ROOTS` before anything runs: `cannot <verb>: it is in a directory you can only read (<read-only roots>)`. The link-count rule does not apply there, because the store keeps hard-linked names and the run-as user cannot add a link where it cannot write, so the box must keep these directories unwritable by that user. The provider fails at load when the list is empty or `modelRoots` is unset, when an entry overlaps a model root, when an entry is or contains the harness home (`$DSH_HOME`), and when an entry is, contains, or lies inside a conventional credential store under the user's home directory (`.ssh`, `.gnupg`, `.aws`, `.azure`, `.config/gcloud`, `.config/gh`, `.docker`, `.kube`, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`). The harness keeps its own credential file directly in `$DSH_HOME`, so no entry inside the home holds it.

```yaml
- name: '@deepseek-ai/dsh-fs-local'
  config:
    modelRoots: [/root/projects, /home/agent]
    readOnlyRoots:
      - /var/lib/mumbo/attachments/attachments/v1
      - /root/.dsh/skills
      - /usr/local/share/mumbo/agents/skills
      - /var/lib/mumbo/spill
      - /var/lib/mumbo/subprocess-spill
```

These roots open the files to the model's `read` only, which runs as this process. The model's shell runs as the run-as user, so a contained box lays the directories out for it to read and never write, with each ancestor searchable by it:

| Directory | Configured by | Layout for the run-as user `agent` |
|---|---|---|
| Attachments | `dsh-attachment-local` `dshHome: /var/lib/mumbo/attachments` with `groupReadable: true` | the home, `attachments`, and `attachments/v1` each `root:agent`, mode `2750`, created by the box because the store creates `attachments/v1` only on its first upload; the store then creates directories `2750` and files `0440` |
| Session spill files | `dsh-spill-local` `root: /var/lib/mumbo/spill` with `groupReadable: true` | `root:agent`, mode `2750`; session directories `2750`, files `0640` |
| Command spill files | `dsh-subprocess-local` `spillDirectory: /var/lib/mumbo/subprocess-spill` | `root:agent`, mode `2750`; files `0640` |
| Skills | `$DSH_AGENTS_HOME/skills` with `DSH_AGENTS_HOME=/usr/local/share/mumbo/agents` | `root:root`, directories `0755`, files `0644` |

Every model and read-only root must exist when the provider loads, or it fails at load, so the box creates each directory in the table, and `$DSH_HOME/skills`, before dsh starts. The harness home (`$DSH_HOME`) itself stays root-only, so skills under `$DSH_HOME/skills` stay readable through `read` but their scripts cannot run from the model's shell.

### What you can do

Read regular UTF-8 files whole or as streams, read bounded bytes, and list one directory level. Create a directory with its missing ancestors; an existing directory is accepted unchanged and a file at the path fails with `FS_NOT_DIRECTORY`. Writes, literal edits, patches, and deletions serialize per target. Moves lock both targets in lexical order. `patchText` checks the version before calling `applyHunks`; `deleteFile` removes only a regular file. Missing sources use `FS_STALE_VERSION`, unmatched hunks use `FS_PATCH_MISMATCH`, and identical move targets use `FS_SAME_TARGET`.

Patch and move text is LF-normalized internally and restored using the source line-ending style; outcome text uses LF. Delete bases and overwritten destination bases follow `diffBasisMaxBytes`. A move checks cancellation before staging the destination, then completes both effects; a source-removal failure returns the published destination with `sourceDeleted: false`. Atomic write failures map denied directory or staging creation to `FS_PERMISSION_DENIED` and other Node I/O errors to `FS_IO_ERROR`.

Read, listing, and mutation failures are typed `FsError`s with stable codes — `FS_NOT_FOUND`, `FS_NOT_TEXT` (binary content), `FS_STALE_VERSION` (changed since observation), `FS_EDIT_NOT_FOUND` or `FS_AMBIGUOUS_EDIT` (no unique literal match), and others — so callers branch on the code, never on message text. A missing target on an edit reports `FS_STALE_VERSION` whether or not the version guard is supplied.

Chokidar observes one file or a directory's direct entries through OS events, without polling or recursive watching. Files use a filtered parent-directory watch, so readiness also covers creation of an initially missing file. File watches cover in-place writes, atomic replacement, deletion, and same-path recreation while the parent directory remains.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the local backend and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

The backend builds on three ideas:

- **Realpath identity.** The `targetKey` is the file's `realpath`, so two input paths reaching the same file through symlinks share one identity, and writes land on the link target while preserving the link.
- **Atomic publication.** Writes stage into an exclusive temp file inside a private staging directory next to the target, fsync, then publish; an existing file's mode is preserved and Windows DACLs survive replacement.
- **One mutation critical section.** A per-target FIFO lock serializes read→guard→write windows, so concurrent writes and edits are deterministically ordered — one wins, the rest see the new version and reject as stale.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service wiring: `LocalFileSystem`, `Config`, per-target mutation lock |
| [`src/fsio.ts`](src/fsio.ts) | Cordis-free raw I/O: probe, reads, atomic write, literal edit, line-ending handling |
| [`src/win32.ts`](src/win32.ts) | Windows-specific DACL preservation for atomic replacement |

### Write path

Each write probes the target, enforces the optional guard (`createIfAbsent` or `replaceIfVersion`), captures a bounded `before` diff basis when both sides are small enough, stages the new content next to the target, fsyncs, and publishes atomically. Guarded creation uses a hard-link publication that never replaces a concurrent creator, rejecting it with `FS_NOT_OBSERVED` instead.

### Edit path

Each edit probes, verifies the version guard before literal matching (so stale edits report `FS_STALE_VERSION`, never a misleading no-match), reads the file, applies the literal replacement with LF normalization, restores the file's dominant line-ending style, and republishes — all inside the per-target lock.

### Ownership and invariants

Raw I/O is Cordis-free and independently unit-tested in `src/fsio.ts`; `src/index.ts` stays thin wiring. `config.cwd` is a resolution default only — containment is the job of `fs-sandbox` or a `tools/execute` permission plugin. Cancellation is a best-effort `AbortSignal` checked before and after each asynchronous probe. For watches, the signal cancels initialization; after readiness, the caller must await the returned close function.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the contract to the adjacent backends, tools, and policies.

- [Filesystem subsystem](../../../docs/subsystems/filesystem.md) — exhaustive provider contract, policy events, and error taxonomy.
- [dsh-fs](../fs/README.md) — the `ctx.fs` contract this backend implements.
- [fs-sandbox](../fs-sandbox/README.md) — the sandbox-enforcing backend that extends this one.
- [tool-fs](../tool-fs/README.md) — the model-facing tools that consume `ctx.fs`.
- [fs-observation-policy](../fs-observation-policy/README.md) — the policy plugin that guards mutations through the `fs/*` events.
- [Windows DACL preservation note](../../../.agents/notes/archived/bug-fix/2026-07-19-windows-atomic-write-dacl-preservation.md) — why atomic replacement copies the target's access policy.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-fs`, which renders this provider's line-windowed UTF-8 content, mutation acknowledgements, and exact provider messages in capped retained results while versions, atomic-write mechanics, and directory metadata remain internal. With `modelRoots`, a refused path reads `cannot access "<path>": its real path is outside the directories you can access (<roots>)`, listing the read-only roots too; a change under a read-only root reads `cannot <verb>: it is in a directory you can only read (<read-only roots>)`.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the local backend is a poor fit or needs special operational care. They are current package constraints, not a general filesystem comparison or a task backlog.

- **`config.cwd` is not a sandbox** — it is a resolution default, not containment: absolute paths and `..` escape it. Confine model paths with `modelRoots`, mutations with a stricter `ctx.fs` backend, or calls with a permission plugin on the `tools/execute` waterfall.
- **Changes without a run-as provider keep a resolution race** — with model roots but no child identity, changes open the canonical path by name in this process, so a process that swaps a directory under a root for a symbolic link between resolution and the change redirects it. Contained deployments configure a run-as subprocess provider, under which the kernel checks each change as that identity. Each helper change also costs one extra process start.
- **Linux parent-directory recreation** — restoring observation after a parent directory is deleted and recreated is deferred; same-path file recreation while its parent remains is supported.
- **Version tokens depend on filesystem metadata** — they combine device, inode, size, nanosecond mtime, and nanosecond ctime; a storage layer that cannot update any of those facts for a rewrite can still defeat the stale guard.
- **`editText` holds the whole file (plus the edited copy) in memory** — streaming exists only on the read path.
- **A sub-limit overwrite still buffers a contextual basis** — `writeText` may retain up to just below `config.diffBasisMaxBytes` of prior text in addition to the caller-owned replacement; the bound does not cap the returned `after` value or the whole-file presentation fallback.
- **Binary detection is asymmetric** — reads NUL-sample only the first 8192 bytes while edits scan the whole buffer, so a file with a late NUL reads fine but rejects edits.
- **The per-target mutation lock is in-process only** — guarded creation still uses an atomic no-replace publication across processes, but replacement writers in another process are caught only when the optional version guard observes their metadata change; they are never serialized.
- **Guarded creation requires hard-link support** — filesystems or mounts that reject hard-link publication cannot serve `createIfAbsent`; the backend preserves the missing target and reports `FS_IO_ERROR`.
- **Post-commit cleanup is best effort** — a successful publication remains successful if removal of its owner-only staging directory fails, leaving private residue for later operator cleanup.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
