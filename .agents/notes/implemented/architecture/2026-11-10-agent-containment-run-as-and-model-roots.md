# Agent Note: Agent containment through a run-as identity and model roots

Status: implemented

## Problem

A Mumbo box runs `dsh` as root. Everything the model asks for runs as root too: its shell commands, terminals, code runtimes, language servers, jobs and subagent shells, and the file tools, which run inside the `dsh` process. Anyone who can steer the model, a project member or injected content, can therefore read the box token (`DEEPSEEK_API_KEY`), `MUMBO_MEMBER_KEY`, the launch token in `/root/dsh.log`, `/proc/<pid>/environ` of root processes, and the browser profile that holds synced passwords and cards. The box side gives the agent its own non-root `agent` user, file permissions and network rules; the harness has to start the model's processes as that user and stop its file tools, which stay in the root process, from reaching anything else.

## Decision

Two opt-in deployment settings, both off by default so upstream behavior is unchanged.

### Run-as identity on the subprocess provider

`@deepseek-ai/dsh-subprocess-local` takes one config row, `runAs`:

```yaml
- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'
  config:
    runAs:
      uid: 1001
      gid: 1001
      groups: []
      inherit: [PATH, LANG, LC_ALL, TERM]
      set: { HOME: /home/agent, TMPDIR: /home/agent/tmp, USER: agent, LOGNAME: agent, SHELL: /bin/bash }
      secretNames: [DEEPSEEK_API_KEY, MUMBO_MEMBER_KEY]
```

Every `spawn` and `spawnTerminal` of the provider then starts the target as that identity. The identity applies to the provider, not to a spawn request, because every model-reachable process except the experimental and harness-owned ones listed below starts through `ctx.subprocess`, and a provider-wide identity covers a spawn path added later without its author opting in. The provider is the one host-plane row a deployment patches; per-Consumer settings would have to be repeated in every Agent Preset realm and would fail open where one was forgotten.

- **Credentials.** The Linux exec bootstrap of the provider (the runner that already restores a target's cwd and environment before `execve`) receives the identity in its root-owned `0600` launch request, then calls `setgroups(groups)`, `setgid(gid)` and `setuid(uid)`, reads `/proc/self/status`, and enters the target only when the real, effective, saved and filesystem ids and the supplementary groups equal the identity. Any refused step or mismatch is a startup error and `done` rejects with `run-as: could not take ...` or `run-as: credentials after the change do not match ...`; the target never runs. Without a user-systemd scope, run-as launches start the bootstrap directly as a detached process group instead of the target, so ordinary, terminal, scoped and unscoped launches share one drop. Node's own `spawn({ uid, gid })` was not used because `node-pty` changes the uid and gid without clearing supplementary groups, and Node's spawn can only clear them, not set an explicit list.
- **Environment.** A run-as child receives only the `inherit` names of the credential-scrubbed `dsh` environment, then the spawn request's explicit entries (an `undefined` entry removes a name), then the `set` values, which replace both. Nothing else from the root environment reaches it. Explicit entries pass because Consumers set them on purpose (for example `DSH_SESSION_ID`, `GIT_INDEX_FILE`, the control-pipe descriptor); requiring every such name in `inherit` would silently drop facts a Consumer relies on.
- **Secret guard.** Before any launch file is written, the provider refuses, with `SubprocessSecretEnvironmentError`, a final environment that contains any `secretNames` entry, compared without case. The check runs on the exact environment the target receives, including launch additions such as `TERM` and `PWD`. Load-time validation separately rejects an `inherit` or `set` name that is a secret, a credential-shaped `inherit` name (the scrub drops it, so inheriting it would do nothing), `uid`, `gid` or a group of `0`, an empty `secretNames`, invalid names, a non-Linux host, and a host whose exec bootstrap is unavailable.
- **Shell activity records.** For an interactive `bash -i` or `zsh -i` terminal with activity observation, the record directory stays root-owned with mode `0711`, the startup file is `0644`, and only the two record files are pre-created and owned by the run-as user, so the shell can write its state but cannot add or replace entries.
- **Lookups.** `resolveExecutable` searches the run-as `PATH`, and `terminalEnvironment().defaultShell` reports the run-as `SHELL` (or nothing), never root's account shell.

### Model roots on the filesystem provider

`@deepseek-ai/dsh-fs-local`, and through inheritance `@deepseek-ai/dsh-fs-sandbox`, takes `modelRoots`, a list of existing absolute directories canonicalized at load:

```yaml
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  config:
    modelRoots: [/root/projects, /home/agent]
```

- The `FileSystem` Service Definition gains `resolveModelPath(path, opts)`. Every model-facing tool resolves model-supplied paths through it: `read` and `read_image` (shared read-target step), `write`, `edit`, `apply_patch`, `str_replace_editor`, `present`, the `glob` and `grep` search root (or the working directory when no path is given), and the LSP host's query source. With roots configured, the local provider realpaths the path first (an absent path through its nearest existing ancestor, so a write target under a symbolically linked parent is judged by where it would land) and refuses, with `FS_OUTSIDE_ROOTS`, any real path outside every root. The model reads `cannot access "<path>": its real path is outside the directories you can access (<roots>)`.
- Every `resolve` call, not only model-facing ones, refuses a path written under a root whose real path leaves all roots. The model can create symbolic links anywhere under its roots, so harness readers of model-writable directories (project instruction files, workspace skills, the Files panel) never follow such a link out. Paths outside the roots that no root contains, such as the harness's own `DSH_HOME`, resolve as before.
- The allowlist is not a denylist: the file tools run in the root `dsh` process, which can read `/proc/<pid>/environ` of any process and every root-only file, so only an explicit set of directories is safe. Shared temporary directories stay out of it for the same reason: every file under a root is readable to the root process whoever owns it. Model roots require Linux.
- **Reads are pinned to the resolved file.** Every read and listing opens its target once (`O_NONBLOCK`) and accepts the descriptor only when `/proc/self/fd/<n>` names the resolved real path, then reads through that descriptor; listings read names and children through it too. A link swapped in after resolution is refused (`FS_OUTSIDE_ROOTS` when the opened file lies outside the roots, `FS_STALE_VERSION` otherwise).
- **Changes run as the run-as user.** The subprocess Service Definition exposes `childIdentity`. When it is set, every `ctx.fs` change (write, edit, patch, delete, move, directory creation) runs in a one-shot helper process (`@deepseek-ai/dsh-fs-local/mutation-helper`) that the run-as provider starts, using the provider's own in-process implementation, so the kernel checks every path component of the change with the run-as identity and a swapped link cannot lead a change outside what that user may write. The parent keeps its per-target locks, decodes the helper's output strictly, and maps its failures back to their filesystem codes. With model roots and no subprocess provider mounted, changes are refused instead of made by root.
- The person's Files panel resolves through plain `resolve` and its own workspace containment, so it is unchanged except that it, like every caller, no longer follows a link out of the model roots.

### Nothing model-reachable loads code into root dsh or starts a root process

`apps/cli/tests/box-containment.spec.ts` composes the person and project boxes (the web profile, the founder's overlays, the edge's rows, and the edge's containment rows in `apps/cli/tests/fixtures/box-edge`) and classifies every mounted package by how its model tools run: none, in-process, model roots, run-as, remote, withheld, or pending a ruling. An unclassified package fails, catalogued tool names must match `docs/tool-catalog.md`, and `dsh-tool-cordis`, `dsh-plugin-market/tools`, the Python PTC runtime, and the SDK subagent must be absent. Two harness switches back the containment rows: `dsh-plugin-manager` `modelTools: false` keeps the `plugin_manager` tool from registering (installing or enabling a plugin loads code into root dsh), and `dsh-workspace-changes` `summaries: false` keeps change summaries from running git or reading files until their scratch directory works as the run-as user. The creator-mode preset (`preset-cordis`) is disabled.

### Spawn paths the model can reach

| Path | Spawn | Coverage |
|---|---|---|
| `bash` and `pwsh` tools, their background jobs (`dsh-tool-bash`, `dsh-bash-local`/`-sandbox`) | `ctx.subprocess.spawn` | Run-as |
| Persistent terminals and `terminal`/`bash` persistent tools (`dsh-terminal-bash`) | `ctx.subprocess.spawnTerminal` | Run-as |
| The person's Terminal tab (`dsh-api-terminal-controller`), which the agent can also drive | `spawnTerminal` through the Agent context's `subprocess` | Run-as |
| PTC code runtime and workflows (`dsh-ptc-runtime-node`, `dsh-workflow-ptc`) | `ctx.subprocess.spawn` | Run-as |
| Language servers (`dsh-lsp-stdio`) | `ctx.subprocess.spawn` | Run-as; query sources also checked against model roots |
| `glob`/`grep` ripgrep (`dsh-tool-fs-search`) | `ctx.subprocess.spawn` | Run-as; search root checked against model roots |
| In-process subagents and forks (`dsh-subagent-spawn-in-process`, `-fork-in-process`) | Their own Agents' shell, terminal, PTC and file tools | Run-as and model roots through the same providers |
| External CLI subagents (`dsh-subagent-acp`, `-claude-code`, `-codex`) | `ctx.subprocess.spawn` | Run-as; a credential they forward under a `secretNames` name is refused |
| Mumbo MCP `task_status`/`task_result` git (`@mumbo/mcp`) | `ctx.subprocess.spawn` | Run-as |
| Superagent worker checks (`@mumbo/superagent` `runAsWorker`) | `ctx.subprocess.spawn` | Run-as |
| Workspace change capture git (`dsh-workspace-changes`) | `ctx.subprocess.spawn` | Run-as; off in boxes (`summaries: false`) |
| SSH helpers, speech recognition, cua-macos, computer-use-x11, client-ui-forge, claude-code-mods, worktree (experimental or non-Linux) | `ctx.subprocess.spawn`/`spawnTerminal` | Run-as when mounted |
| Python PTC runtime (`dsh-ptc-runtime-python`, experimental) | `node:child_process` directly | **Not covered**; must not be mounted under run-as |
| SDK subagent (`dsh-subagent-dsh-sdk`) | A child `dsh` through the SDK client | **Not covered**; the child runs as root under its own profile |
| MCP stdio servers (`dsh-mcp-client`) | MCP SDK transport | Harness-owned by design; root with the scrubbed environment |
| Plugin installation (`dsh-plugin-manager` git and pnpm) | `node:child_process` | Harness-owned, root; the model tool is withheld in boxes (`modelTools: false`) |
| Playwright MCP server (`@mumbo/browser-consent`, person boxes) | MCP SDK stdio transport | **Root; pending a ruling** |
| Computer use (`dsh-computer-use-x11`, person boxes) | `ctx.subprocess.spawn` | Run-as, which cannot reach the X display; **pending a ruling** |
| Superagent orchestrator tools (`@mumbo/superagent`, project boxes) | `node:child_process` (`gh`, `git`) | **Root; pending a ruling** |
| Superagent GitHub and Feishu CLIs, sandbox probes, open-in-app and other host commands | `node:child_process` | Harness-owned, root |

## Alternatives considered

**A run-as field on each spawn request.** Each Consumer would declare whether its process acts for the model. It is explicit, but every current and future spawn path would have to opt in, the Consumers inside Agent Preset realms would each need the identity, and an omission would run as root silently. The provider-wide identity fails closed for new paths; the harness's credentialed processes already spawn outside the seam.

**`dsh`'s own sandbox (bubblewrap or Landlock).** It confines writes, not reads, applies per mode with user-approved escalation to Full access, does not cover the person's Terminal tab, and was unavailable on Fargate. A uid boundary holds regardless of mode and approval.

**Node's `spawn({ uid, gid })` and `node-pty`'s `uid`/`gid`.** They need no bootstrap, but `node-pty` keeps root's supplementary groups and neither can set an explicit group list.

**A wrapper program such as `setpriv`.** It would run as root with the target's environment, which the dynamic loader honors (`LD_PRELOAD`), and adds an external dependency. The bootstrap keeps the target environment in a root-only request file and runs with `dsh`'s own scrubbed environment until it has dropped privileges.

**Strict allowlisting of explicit environment entries too.** It would make a forwarded secret impossible under any name, but it silently drops Consumer facts that correctness depends on (`GIT_INDEX_FILE` in change capture would make git write the user's real index). The secret guard covers named secrets instead.

**Enforcing model roots in every `resolve`.** It would cover any future model tool without an opt-in, but it would break harness reads of `DSH_HOME` (global instructions, skills, spill files) and change the Files panel. Only the symbolic-link escape rule applies to every caller.

**A per-tool `tools/pre-execute` path filter.** Tool arguments name paths in different fields and forms, and a filter before resolution cannot see symbolic links; enforcement belongs at the resolution that produces the target.

## Consequences

- With both settings, a model-driven process cannot read root-only files or other users' files, cannot read `/proc/<pid>/environ` of root processes, and starts without the box credentials; the model's file tools cannot name a path outside the roots or follow a link out of them.
- `dsh` itself still runs as root. A flaw in `dsh` or in any in-process plugin, or a harness process that interprets model-writable content as root, reaches everything. The composition gate keeps model tools that load code or start root processes out of the box compositions, except those pending a ruling (the Playwright MCP server, computer use, the superagent's CLIs). Without `modelTools: false` the plugin-manager tool installs and enables bundles in the root process without approval under Full access.
- Reads are pinned to the resolved file and changes run as the run-as user, so a link swapped in during a tool call can neither be read through nor written through outside the roots. Without a run-as provider, changes still open the canonical path by name in the root process and keep that race. Each change costs one helper process start (about 0.3 s from source).
- Run-as children need read access to `dsh`'s own code for the PTC runtime and to any executable they run; `dsh`'s source tree, `node_modules` and `DSH_HOME` must stay unwritable by the run-as user, or it can change code that root executes.
- Harness-initiated work that now runs as the run-as user needs paths that user can use: workspace change capture keeps its scratch index under a root-owned `0700` temporary directory and fails under run-as until it creates that scratch for the run-as user; superagent worker checks read their git configuration and shims from `DSH_HOME`.
- Each run-as launch starts one extra Node bootstrap before `execve`, which systemd-scoped launches already paid.
- Credential-dropping cannot be exercised by a non-root test run. The suites run the bootstrap with the test's own identity, prove a different identity is refused, and assert the request and argv the provider produces; the box's escape tests run as the real `agent` user.

## Testing

`packages/fs/fs-local/tests/child-mutations.spec.ts` covers changes in the helper, its protocol, kernel refusal through an unwritable directory, and routing; the model-roots spec races a link swap against every read kind. The base composition test also races a swap against the `read` and `write` tools and checks that every write ran in a helper. `apps/cli/tests/box-containment.spec.ts` is the composition gate. `packages/subprocess/subprocess-local/tests/run-as.spec.ts` covers configuration validation, the environment composition, the secret guard on ordinary and terminal launches, real ordinary and terminal children reporting `/proc/self/status` credentials and their exact environment, refusal of an identity the process cannot take, the bootstrap's drop order and verification, scoped and unscoped launch requests, and the shared activity records. `packages/fs/fs-local/tests/model-roots.spec.ts` covers the provider rules, including file and directory links, a write target under a linked parent, `..`, `/proc/self/environ` and `/proc/1/environ`; the `tool-fs`, `tool-fs-search`, `tool-str-replace-editor`, `tool-present` and `lsp-stdio` suites pin the model-visible refusals through each operation. `packages/bundle/base/tests/containment.spec.ts` boots both settings through a `cordis.yml` Loader composition and drives the `bash`, `read` and `write` tools.
