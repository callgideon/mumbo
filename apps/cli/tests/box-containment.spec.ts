/**
 * Containment gate over the mumbo box compositions: the web profile, the founder's overlays, the rows the edge writes,
 * and the edge's containment rows (fixtures/box-edge). Every mounted package is classified by how its model-visible
 * tools run; an unclassified package fails, catalogued tool names must match, the packages that would load code into
 * root dsh or start a root process for the model must be switched off or absent, every subprocess identity a row
 * names must be the one its classification expects and a configured non-root identity of its own, every MCP stdio
 * server that names no identity must start as the dedicated `mcpserver` identity, never as root or `agent`, the
 * project box's `dsh-superagent` row is the founder's overlay row, read with the directories the start script exports,
 * `agent`'s PATH names only root's directories and its own npm global prefix and ~/.local/bin, and `web_fetch` goes
 * to the DeepSeek Fetch API at the edge's model host. The person box includes the door to Mumbo (`@mumbo/mcp`), whose
 * tools the edge calls for the person, Run Wild (`@mumbo/run-wild`), and the state block (`@mumbo/state`), which the
 * project overlay mounts in project boxes too.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { boot, composeEntries, loadOverlayPatches, loadProfile } from '@deepseek-ai/dsh-app-boot'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebDeepseekApi from '@deepseek-ai/dsh-web-deepseek-api'
import * as WebFetchHttp from '@deepseek-ai/dsh-web-fetch-http'

const root = resolve(import.meta.dirname, '../../..')
const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const deployed = (name: string) => loadOverlayPatches('dsh', join(root, 'deploy', name))
const edge = (name: string) => loadOverlayPatches('dsh', join(import.meta.dirname, 'fixtures/box-edge', name))
/** The overlay the edge patches into person boxes for the door to Mumbo. */
const door = () => loadOverlayPatches('dsh', join(root, 'packages/mumbo/mcp/examples/person.overlay.yml'))
/** The overlay the edge patches into person boxes for Run Wild. */
const runWild = () => loadOverlayPatches('dsh', join(root, 'packages/mumbo/run-wild/examples/person.overlay.yml'))
/** The overlay the edge patches into person boxes for the state block. */
const state = () => loadOverlayPatches('dsh', join(root, 'packages/mumbo/state/examples/person.overlay.yml'))

/** How a package's model-visible tools run in a contained box. */
type Runs =
  /** Registers no model-visible tool. */
  | 'none'
  /** Runs inside root dsh, starts no process, and touches no file outside the model roots. */
  | 'in-process'
  /** Reads files in root dsh through `resolveModelPath` and descriptor-checked opens; changes files as the run-as user. */
  | 'model-roots'
  /** Starts its processes through the run-as subprocess provider, as `agent` or as the identity its row names. */
  | 'run-as'
  /** Runs on another host; root dsh relays requests over the network. */
  | 'remote'
  /** Mounted, but the containment rows withhold its tool from the model. */
  | 'withheld'

interface Classification {
  runs: Runs
  /** Model-visible tool names; a `*` suffix names a dynamic family. */
  tools: readonly string[]
  /** Tools of the same package that start processes through the run-as provider as `agent`, although its others run as `runs`. */
  runAsTools?: readonly string[]
  /** The docs/tool-catalog.md package whose tool names must equal `tools`, when it is catalogued. */
  catalog?: string
  /** The subprocess identity, other than the default `agent`, that the package's row names for its processes. */
  identity?: string
  /** Whether a row with this config starts processes and so must name `identity`; omitted, every row does. */
  startsProcesses?: (config: Record<string, unknown> | undefined) => boolean
  /** The identity is the one each row names for itself, such as an MCP stdio server row's, instead of `identity`. */
  identityFromRow?: true
  note?: string
}

const NONE: Classification = { runs: 'none', tools: [] }

/** Every package a box composition mounts. Browser-side `@deepseek-ai/dsh-client-*` packages register no host tool. */
const CLASSIFICATION: Readonly<Record<string, Classification>> = {
  '@deepseek-ai/cordis-plugin-timer': NONE,
  '@deepseek-ai/dsh-agent': NONE,
  '@deepseek-ai/dsh-agent-default-model': NONE,
  '@deepseek-ai/dsh-agent-instructions': NONE,
  '@deepseek-ai/dsh-agent-loop': NONE,
  '@deepseek-ai/dsh-agent-preset': NONE,
  '@deepseek-ai/dsh-agent-preset-registry': NONE,
  '@deepseek-ai/dsh-agent-team': NONE,
  '@deepseek-ai/dsh-api-gateway': NONE,
  '@deepseek-ai/dsh-api-job-controller': NONE,
  '@deepseek-ai/dsh-api-remote-access': NONE,
  '@deepseek-ai/dsh-api-remotes': NONE,
  '@deepseek-ai/dsh-api-session-controller': NONE,
  '@deepseek-ai/dsh-api-settings-controller': NONE,
  '@deepseek-ai/dsh-api-terminal-controller': { ...NONE, note: 'the person\'s Terminal tab; its shells start through the run-as provider' },
  '@deepseek-ai/dsh-api-workspace-controller': NONE,
  '@deepseek-ai/dsh-api-workspace-files': { ...NONE, note: 'the person\'s Files panel' },
  '@deepseek-ai/dsh-attachment-local': NONE,
  '@deepseek-ai/dsh-authorization': NONE,
  '@deepseek-ai/dsh-bash-sandbox': { ...NONE, note: 'the shell executor; its commands start through the run-as provider' },
  '@deepseek-ai/dsh-browser-use': NONE,
  '@deepseek-ai/dsh-command-compact': NONE,
  '@deepseek-ai/dsh-command-feedback': NONE,
  '@deepseek-ai/dsh-command-goal': NONE,
  '@deepseek-ai/dsh-commands': NONE,
  '@deepseek-ai/dsh-compaction-basic': NONE,
  '@deepseek-ai/dsh-compaction-image-offload': NONE,
  '@deepseek-ai/dsh-compaction-tool-result-pruner': NONE,
  '@deepseek-ai/dsh-computer-use': NONE,
  '@deepseek-ai/dsh-computer-use-x11': {
    runs: 'run-as', tools: ['computer'], identity: 'desktop', note: 'xdotool, xsel, and import, with every xdotool argument checked',
  },
  '@deepseek-ai/dsh-config-editor': NONE,
  '@deepseek-ai/dsh-cordis-client-runner': { ...NONE, note: 'the browser half of the Cordis runner' },
  '@deepseek-ai/dsh-cordis-host-runner': { ...NONE, note: 'browser-driven definitions only; no model tool creates them' },
  '@deepseek-ai/dsh-credentials-local': NONE,
  '@deepseek-ai/dsh-deepseek-llm-api-extensions': NONE,
  '@deepseek-ai/dsh-deliverable-file-references': NONE,
  '@deepseek-ai/dsh-file-reference-local': NONE,
  '@deepseek-ai/dsh-fs-sandbox': NONE,
  '@deepseek-ai/dsh-goal': NONE,
  '@deepseek-ai/dsh-goal-round-driver': NONE,
  '@deepseek-ai/dsh-hmr': NONE,
  '@deepseek-ai/dsh-hooks-claude-code': { ...NONE, note: 'ruling #4: hook commands run through the shell, so as `agent`' },
  '@deepseek-ai/dsh-host-directory-picker-auto': NONE,
  '@deepseek-ai/dsh-host-open-in-app': {
    ...NONE, note: 'launches as root; under the run-as provider it resolves no PATH name, since agent may write agent\'s PATH',
  },
  '@deepseek-ai/dsh-host-plugin-inventory': NONE,
  '@deepseek-ai/dsh-host-webserver': NONE,
  '@deepseek-ai/dsh-jobs-local': NONE,
  '@deepseek-ai/dsh-llm': NONE,
  '@deepseek-ai/dsh-llm-deepseek-api-key': NONE,
  '@deepseek-ai/dsh-llm-pi-ai': NONE,
  '@deepseek-ai/dsh-llm-retry': NONE,
  '@deepseek-ai/dsh-mcp-client': {
    runs: 'remote', tools: ['mcp__sandboxes__*'], identityFromRow: true, startsProcesses: config => config?.transport !== 'streamable-http',
    note: 'the edge\'s sandboxes server over HTTP; a stdio server runs as the identity its row names, or as mcpserver',
  },
  '@deepseek-ai/dsh-mcp-manager': {
    runs: 'run-as', tools: ['mcp__*'],
    note: 'servers the person adds; mcp-client starts each stdio server through the run-as provider as the server identity, mcpserver, in its home',
  },
  '@deepseek-ai/dsh-mcp-resources': {
    runs: 'remote', tools: ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'], catalog: '@deepseek-ai/dsh-mcp-resources',
  },
  '@deepseek-ai/dsh-message-feedback': NONE,
  '@deepseek-ai/dsh-message-quotes': NONE,
  '@deepseek-ai/dsh-office-to-pdf': { ...NONE, note: 'document previews the person opens' },
  '@deepseek-ai/dsh-otel': NONE,
  '@deepseek-ai/dsh-permission-presets': NONE,
  '@deepseek-ai/dsh-persona': NONE,
  '@deepseek-ai/dsh-plan-mode': { runs: 'in-process', tools: ['exit_plan_mode'], catalog: '@deepseek-ai/dsh-plan-mode' },
  '@deepseek-ai/dsh-plugin-manager': { ...NONE, note: 'the service; its model tool is the /tools row' },
  '@deepseek-ai/dsh-plugin-manager/tools': { runs: 'withheld', tools: ['plugin_manager'], catalog: '@deepseek-ai/dsh-plugin-manager' },
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek': NONE,
  '@deepseek-ai/dsh-ptc-runtime-node': { ...NONE, note: 'the code runtime behind run_code and workflow; it starts through the run-as provider' },
  '@deepseek-ai/dsh-repeat-tool-reminder': NONE,
  '@deepseek-ai/dsh-sandbox-local': NONE,
  '@deepseek-ai/dsh-sandbox-policy': NONE,
  '@deepseek-ai/dsh-schedule': NONE,
  '@deepseek-ai/dsh-session': NONE,
  '@deepseek-ai/dsh-session-checkpoint-policy': NONE,
  '@deepseek-ai/dsh-session-log-export': NONE,
  '@deepseek-ai/dsh-session-persistence-jsonl': NONE,
  '@deepseek-ai/dsh-session-projection': NONE,
  '@deepseek-ai/dsh-session-projection-cache': NONE,
  '@deepseek-ai/dsh-session-query-sqlite': NONE,
  '@deepseek-ai/dsh-session-reference': NONE,
  '@deepseek-ai/dsh-session-stats': NONE,
  '@deepseek-ai/dsh-session-telemetry-otel': NONE,
  '@deepseek-ai/dsh-session-title': NONE,
  '@deepseek-ai/dsh-session-title-first-prompt-llm': NONE,
  '@deepseek-ai/dsh-session-turn-outline': NONE,
  '@deepseek-ai/dsh-settings': NONE,
  '@deepseek-ai/dsh-shell-env': NONE,
  '@deepseek-ai/dsh-skill': NONE,
  '@deepseek-ai/dsh-skill-filesystem': NONE,
  '@deepseek-ai/dsh-spill-local': NONE,
  '@deepseek-ai/dsh-spill-policy': NONE,
  '@deepseek-ai/dsh-storage': NONE,
  '@deepseek-ai/dsh-storage-domain': NONE,
  '@deepseek-ai/dsh-storage-json': NONE,
  '@deepseek-ai/dsh-subagent': NONE,
  '@deepseek-ai/dsh-subagent-fork-in-process': NONE,
  '@deepseek-ai/dsh-subagent-spawn-in-process': NONE,
  '@deepseek-ai/dsh-subprocess-local': NONE,
  '@deepseek-ai/dsh-system-prompt': NONE,
  '@deepseek-ai/dsh-terminal': NONE,
  '@deepseek-ai/dsh-terminal-bash': NONE,
  '@deepseek-ai/dsh-time-context': NONE,
  '@deepseek-ai/dsh-token-meter': NONE,
  '@deepseek-ai/dsh-tool-agent-team': {
    runs: 'in-process', tools: ['team_task_create', 'team_task_get', 'team_task_list', 'team_task_update'], catalog: '@deepseek-ai/dsh-tool-agent-team',
  },
  '@deepseek-ai/dsh-tool-ask-user': { runs: 'in-process', tools: ['ask_user_question'], catalog: '@deepseek-ai/dsh-tool-ask-user' },
  '@deepseek-ai/dsh-tool-bash': { runs: 'run-as', tools: ['bash'], catalog: '@deepseek-ai/dsh-tool-bash' },
  '@deepseek-ai/dsh-tool-bash-persistent': { runs: 'run-as', tools: ['bash'], catalog: '@deepseek-ai/dsh-tool-bash-persistent' },
  '@deepseek-ai/dsh-tool-call-timeout-policy': NONE,
  '@deepseek-ai/dsh-tool-cordis/host': { ...NONE, note: 'inspection providers; the model tool is @deepseek-ai/dsh-tool-cordis' },
  '@deepseek-ai/dsh-tool-executor-native': NONE,
  '@deepseek-ai/dsh-tool-executor-ptc': { runs: 'run-as', tools: ['run_code'], catalog: '@deepseek-ai/dsh-tool-executor-ptc' },
  '@deepseek-ai/dsh-tool-fs': {
    runs: 'model-roots', tools: ['apply_patch', 'edit', 'read', 'read_image', 'write'], catalog: '@deepseek-ai/dsh-tool-fs',
  },
  '@deepseek-ai/dsh-tool-fs-search': {
    runs: 'run-as', tools: ['glob', 'grep'], catalog: '@deepseek-ai/dsh-tool-fs-search', note: 'search roots also checked against the model roots',
  },
  '@deepseek-ai/dsh-tool-goal': { runs: 'in-process', tools: ['create_goal', 'get_goal', 'update_goal'], catalog: '@deepseek-ai/dsh-tool-goal' },
  '@deepseek-ai/dsh-tool-jobs': { runs: 'in-process', tools: ['job_kill', 'job_list', 'job_output'], catalog: '@deepseek-ai/dsh-tool-jobs' },
  '@deepseek-ai/dsh-tool-present': { runs: 'model-roots', tools: ['present'], catalog: '@deepseek-ai/dsh-tool-present' },
  '@deepseek-ai/dsh-tool-schedule': {
    runs: 'in-process', tools: ['schedule_create', 'schedule_edit', 'schedule_list', 'schedule_view'], catalog: '@deepseek-ai/dsh-tool-schedule',
  },
  '@deepseek-ai/dsh-tool-skill': { runs: 'in-process', tools: ['skill'], catalog: '@deepseek-ai/dsh-tool-skill' },
  '@deepseek-ai/dsh-tool-subagent': { runs: 'in-process', tools: ['list_subagent_models', 'subagent'], catalog: '@deepseek-ai/dsh-tool-subagent' },
  '@deepseek-ai/dsh-tool-subagent-control': {
    runs: 'in-process', tools: ['interrupt_agent', 'list_agents', 'send_message', 'wait_agent'], catalog: '@deepseek-ai/dsh-tool-subagent-control',
  },
  '@deepseek-ai/dsh-tool-subagent/model-selection-settings': NONE,
  '@deepseek-ai/dsh-tool-todo': { runs: 'in-process', tools: ['todo_write'], catalog: '@deepseek-ai/dsh-tool-todo' },
  '@deepseek-ai/dsh-tool-web': {
    runs: 'remote', tools: ['web_fetch', 'web_search'], catalog: '@deepseek-ai/dsh-tool-web',
    note: 'searches and fetches go to the DeepSeek Search and Fetch APIs through the edge\'s model host, never from the box to an address the model names',
  },
  '@deepseek-ai/dsh-tool-workflow': { runs: 'in-process', tools: ['workflow'], catalog: '@deepseek-ai/dsh-tool-workflow' },
  '@deepseek-ai/dsh-tool-working-directory': {
    runs: 'in-process', tools: ['working_directory'], catalog: '@deepseek-ai/dsh-tool-working-directory',
  },
  '@deepseek-ai/dsh-tools': NONE,
  '@deepseek-ai/dsh-typert-loader': NONE,
  '@deepseek-ai/dsh-typert-registry': NONE,
  '@deepseek-ai/dsh-user-approval': NONE,
  '@deepseek-ai/dsh-user-questions': NONE,
  '@deepseek-ai/dsh-web': NONE,
  '@deepseek-ai/dsh-web-app': NONE,
  '@deepseek-ai/dsh-web-app/startup': NONE,
  '@deepseek-ai/dsh-web-deepseek-api': NONE,
  '@deepseek-ai/dsh-web-search-deepseek': NONE,
  '@deepseek-ai/dsh-workflow-ptc': NONE,
  '@deepseek-ai/dsh-working-directory': NONE,
  '@deepseek-ai/dsh-workspace': NONE,
  '@deepseek-ai/dsh-workspace-changes': { ...NONE, note: 'summaries must be off; checked below' },
  '@mumbo/box-links': {
    ...NONE, identity: 'desktop', startsProcesses: config => config?.browser != null, note: 'the person\'s Browser tab runs wmctrl',
  },
  '@mumbo/browser-consent': {
    runs: 'run-as', tools: ['mcp__playwright-mcp__*'], identity: 'browsermcp', note: 'the Playwright MCP stdio server; uploads only from the shared Downloads',
  },
  '@mumbo/edge-member': NONE,
  '@mumbo/run-wild': { ...NONE, note: 'decides asks in the person\'s Run Wild Sessions; registers no tool' },
  '@mumbo/state': { runs: 'in-process', tools: ['plan_read'], note: 'returns the approved plan\'s text from the Session log' },
  '@mumbo/mcp': {
    runs: 'in-process', tools: ['agent_read', 'agent_send', 'needs_you', 'task_reply'], runAsTools: ['task_result', 'task_status'],
    note: 'the door to Mumbo, served to the edge on its own loopback listener for the person\'s Mumbo, not to the box\'s model: '
      + 'data only, except git in assistantCwd, which task_status and task_result run through the run-as provider as agent',
  },
  '@mumbo/superagent': {
    runs: 'in-process',
    tools: [
      'orchestrator_ack', 'orchestrator_eval', 'orchestrator_eval_decide', 'orchestrator_eval_read', 'orchestrator_read', 'orchestrator_reply',
      'orchestrator_report', 'orchestrator_review', 'orchestrator_route', 'orchestrator_thread_follow', 'orchestrator_thread_unrelated',
      'orchestrator_thread_unsubscribe', 'orchestrator_ticket_note', 'orchestrator_ticket_request_status', 'orchestrator_ticket_retry',
      'orchestrator_trigger_handback', 'orchestrator_trigger_requeue',
    ],
    note: 'project boxes, root in-process and data only: the Store, and `gh api` on the configured repository through a root-owned CLI '
      + 'and GH_CONFIG_DIR; no tool runs a command or a path the model names; ticket directories are made and checked as agent',
  },
  '@mumbo/superagent/github-watch': NONE,
}

/**
 * Packages that load code into root dsh, start a root process for the model, or send root dsh's requests to any address
 * the model names, loopback and private ones included; no box may mount them.
 */
const FORBIDDEN = [
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-plugin-market/tools',
  '@deepseek-ai/dsh-experimental-ptc-runtime-python',
  '@deepseek-ai/dsh-subagent-dsh-sdk',
  '@deepseek-ai/dsh-web-fetch-http',
]

interface Row { id?: string; name?: string; disabled?: unknown; inject?: unknown; config?: unknown }

/** agent's gh configuration directory, which holds the person's GitHub sign-in in a person box: agent's, 0700. */
const AGENT_GH = '/var/lib/mumbo/agent-gh'

/**
 * How each model tool of the person box runs in a turn a project's report started, under `@mumbo/mcp`'s report-turn
 * gate: `runs` unasked, or `asks` the person and is refused under Run Wild; in the browser family, reads run and the
 * rest asks. A `*` suffix names a dynamic family.
 */
const REPORT_TURN: Readonly<Record<string, 'runs' | 'asks' | 'browser reads run'>> = {
  apply_patch: 'asks',
  ask_user_question: 'asks',
  bash: 'asks',
  computer: 'asks',
  create_goal: 'asks',
  edit: 'asks',
  exit_plan_mode: 'asks',
  get_goal: 'runs',
  glob: 'runs',
  grep: 'runs',
  interrupt_agent: 'asks',
  job_kill: 'asks',
  job_list: 'runs',
  job_output: 'asks',
  list_agents: 'asks',
  list_mcp_resource_templates: 'asks',
  list_mcp_resources: 'asks',
  list_subagent_models: 'asks',
  'mcp__*': 'asks',
  'mcp__playwright-mcp__*': 'browser reads run',
  'mcp__sandboxes__*': 'asks',
  plan_read: 'runs',
  plugin_manager: 'asks',
  present: 'asks',
  read: 'runs',
  read_image: 'runs',
  read_mcp_resource: 'asks',
  run_code: 'asks',
  schedule_create: 'asks',
  schedule_edit: 'asks',
  schedule_list: 'asks',
  schedule_view: 'asks',
  send_message: 'asks',
  skill: 'asks',
  subagent: 'asks',
  team_task_create: 'asks',
  team_task_get: 'asks',
  team_task_list: 'asks',
  team_task_update: 'asks',
  todo_write: 'runs',
  update_goal: 'asks',
  wait_agent: 'asks',
  web_fetch: 'asks',
  web_search: 'asks',
  workflow: 'asks',
  working_directory: 'asks',
  write: 'asks',
}

/** The directories a contained project box's start script exports for the project overlay's `dsh-superagent` row. */
const CONTAINMENT_ENV = { MUMBO_WORK_DIR: '/root/work', MUMBO_WORKER_DIR: '/var/lib/mumbo/superagent', MUMBO_GH_CONFIG_DIR: '/root/.config/gh' }

/**
 * Evaluate `!!js` values in a row's field the way a contained Linux box boots it: the launcher supplies a profile
 * context, `dshHomePath` names a path under root's DSH home, and `env` is the environment.
 */
function evaluated(value: unknown, env: Record<string, string> = {}): unknown {
  if (Array.isArray(value)) return value.map(entry => evaluated(entry, env))
  if (typeof value !== 'object' || value === null) return value
  if (!('__jsExpr' in value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, evaluated(entry, env)]))
  const context = { get: (name: string) => (name === 'profileContext' ? {} : undefined) }
  // The expressions are the repository's own composition files.
  // oxlint-disable-next-line typescript/no-implied-eval
  const evaluate = new Function('ctx', 'process', 'dshHomePath', `return (${String(value.__jsExpr)})`) as (ctx: unknown, process: unknown, home: unknown) => unknown
  return evaluate(context, { platform: 'linux', env }, (name: string) => `/root/.dsh/${name}`)
}

/** Evaluate a row's `disabled` value the way a contained Linux box boots it. */
function isDisabled(value: unknown): boolean {
  return Boolean(evaluated(value))
}

/** Enabled rows, descending into groups and agent presets. */
function enabledRows(rows: readonly Row[]): Row[] {
  return rows.flatMap((row) => {
    if (isDisabled(row.disabled)) return []
    if (row.name === 'cordis:group' && Array.isArray(row.config)) return enabledRows(row.config as Row[])
    if (row.name === '@deepseek-ai/dsh-agent-preset') return [row, ...enabledRows((row.config as { plugins: Row[] }).plugins)]
    return [row]
  })
}

/** The box's composed rows, with the edge's containment rows unless `contained` is false. */
function compose(box: 'person' | 'project', contained = true): Row[] {
  const home = mkdtempSync(join(tmpdir(), 'dsh-box-containment-'))
  try {
    const profile = loadProfile('dsh', 'web', installAnchor, home)
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
      deployed('mumbo.overlay.yml'),
      deployed('mumbo-personal.overlay.yml'),
      ...box === 'person' ? [edge('personal.overlay.yml'), door(), runWild(), state()] : [edge('project.overlay.yml'), deployed('mumbo-project.overlay.yml')],
      ...contained ? [edge(`containment-${box}.overlay.yml`)] : [],
    ], message => warnings.push(message))
    expect(warnings).toEqual([])
    return rows
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Every `identity` value in a row's config, at any depth: the subprocess identities the row's processes run as. */
function namedIdentities(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, entry]) => key === 'identity' && typeof entry === 'string' ? [entry] : namedIdentities(entry))
}

/** The identity every MCP stdio server that names no identity runs as in a box: a user of its own, never root or `agent`. */
const SERVER_IDENTITY = 'mcpserver'

/** The identities that run a server in each box, each in its own home: the server identity and the Playwright MCP server's. */
const SERVER_IDENTITIES = { person: [SERVER_IDENTITY, 'browsermcp'], project: [SERVER_IDENTITY] } as const

/** Root's directories, the only ones a server identity's `PATH` may name, so no model-writable directory supplies its code. */
const SYSTEM_PATH = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']

/** The box's group `uploads`, which owns browser consent's staged copies: the only group the Playwright MCP server's identity holds. */
const UPLOADS_GID = 1009

/**
 * Ids of the enabled rows that could start an MCP stdio server as root, or as another identity than {@link SERVER_IDENTITY}.
 * mcp-client starts a stdio server that names no identity as this process unless the subprocess provider mounted at that
 * connection runs children as a run-as identity, and then as that provider's `serverIdentity`; every server the manager
 * starts names none; every transport but Streamable HTTP starts a process. Such a row is contained only when every
 * subprocess provider row sets `runAs` and names `mcpserver` as its `serverIdentity`, and the row injects `subprocess`, so
 * it runs only while a provider is mounted: none after a provider remount or a provider failed at load.
 */
function rootStdioServers(rows: readonly Row[]): string[] {
  const enabled = enabledRows(rows)
  const providers = enabled.filter(row => row.name === '@deepseek-ai/dsh-subprocess-local')
  const runAs = providers.length > 0 && providers.every((row) => {
    const config = row.config as { runAs?: unknown; serverIdentity?: unknown } | undefined
    return config?.runAs !== undefined && config.serverIdentity === SERVER_IDENTITY
  })
  return enabled.flatMap((row) => {
    const config = row.config as { transport?: unknown; identity?: unknown } | undefined
    const starts = row.name === '@deepseek-ai/dsh-mcp-manager'
      || (row.name === '@deepseek-ai/dsh-mcp-client' && config?.transport !== 'streamable-http' && typeof config?.identity !== 'string')
    const contained = runAs && Array.isArray(row.inject) && row.inject.includes('subprocess')
    return starts && !contained ? [row.id ?? '(no id)'] : []
  })
}

/** A builder of the superagent copy's model tools for one Session. */
type SuperagentTools = (host: object, owner: object) => readonly { name: string }[]

/** A stand-in for every value a tool builder reads from its host while it builds descriptions: any property, call, or text. */
const anything: object = new Proxy(() => undefined, {
  get: (_target, key) => key === Symbol.toPrimitive ? () => 'stand-in' : anything,
  apply: () => anything,
})

/**
 * Tool names the superagent copy registers: it registers exactly what `mainTools` builds for its main Session and
 * `executorTools` for an Executor Session (`src/app/runtime.ts`), whose tools differ for a review Ticket's Session, so the
 * names come from calling them, whatever a name is or wherever a tool is defined.
 */
async function superagentTools(): Promise<string[]> {
  // The copy is private and exports no tool builders; its sources are loaded from the repository.
  const load = async (file: string, name: string): Promise<SuperagentTools> =>
    ((await import(pathToFileURL(join(root, 'packages/mumbo/superagent/src/app/tools', file)).href)) as Record<string, SuperagentTools>)[name]!
  const [main, executor] = await Promise.all([load('main.ts', 'mainTools'), load('executor.ts', 'executorTools')])
  // A ticket with or without `review`, the field that gives a review Ticket's Session its own tools.
  const ticket = (review: object | undefined): object => new Proxy({}, { get: (_target, key) => key === 'review' ? review : anything })
  const tools = [...main(anything, anything), ...executor(anything, ticket(undefined)), ...executor(anything, ticket(anything))]
  return [...new Set(tools.map(tool => tool.name))].sort()
}

/** The registration `@mumbo/mcp` performs on each request's MCP server, for one profile. */
type RegisterTools = (server: { registerTool(name: string): void }, deps: object, profile: 'full' | 'door') => void

/**
 * Tool names the door profile of `@mumbo/mcp` serves: its per-request server registers exactly what `registerTools`
 * registers for the configured profile (`src/index.ts`), so the names come from calling it, whatever module defines them.
 */
async function doorTools(): Promise<string[]> {
  const names: string[] = []
  const server = { registerTool: (name: string) => { names.push(name) } }
  // The door profile's dependencies: `task_reply` answers questions only.
  const deps = new Proxy({}, { get: (_target, key) => key === 'questionsOnly' ? true : anything })
  // The package is private and not a dependency of this app; its source is loaded from the repository.
  const { registerTools } = await import(pathToFileURL(join(root, 'packages/mumbo/mcp/src/index.ts')).href) as { registerTools: RegisterTools }
  registerTools(server, deps, 'door')
  return names.sort()
}

/**
 * Tool names `@mumbo/state` registers: its plugin registers each tool through `ctx.tools.register` in `apply`
 * (`src/index.ts`), so the names come from applying it to a context that records them.
 */
async function stateTools(): Promise<string[]> {
  const names: string[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: { name: string }) => { names.push(tool.name) } },
    // Without `then`, so the awaited registration resolves.
    sessionProjections: { register: () => Promise.resolve({ stateOf: anything }) },
  }
  const ctx = new Proxy({}, { get: (_target, key) => typeof key === 'string' && key in services ? services[key] : anything })
  // The package is private and not a dependency of this app; its source is loaded from the repository.
  const { apply } = await import(pathToFileURL(join(root, 'packages/mumbo/state/src/index.ts')).href) as { apply: (ctx: object, config: object) => Promise<void> }
  await apply(ctx, { maxChars: 1600 })
  return names.sort()
}

/** Every string value in a config, at any depth. */
function configStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value !== 'object' || value === null) return []
  return Object.values(value).flatMap(configStrings)
}

/** Tool names per package from the generated tool catalog's package map. */
function catalogTools(): Map<string, string[]> {
  const text = readFileSync(join(root, 'docs/tool-catalog.md'), 'utf8')
  const map = new Map<string, string[]>()
  for (const match of text.matchAll(/^\| `(@[^`]+)` \| ([^|]+) \|/gmu)) {
    map.set(match[1]!, [...match[2]!.matchAll(/`([^`]+)`/gu)].map(name => name[1]!).sort())
  }
  return map
}

describe.each(['person', 'project'] as const)('the %s box composition', (box) => {
  const rows = compose(box)
  const enabled = enabledRows(rows)
  const names = [...new Set(enabled.map(row => row.name).filter((name): name is string => name !== undefined))]

  it('classifies every mounted package by how its model tools run', () => {
    const unknown = names.filter(name => !name.startsWith('@deepseek-ai/dsh-client-') && CLASSIFICATION[name] === undefined)
    expect(unknown).toEqual([])
    const catalog = catalogTools()
    for (const name of names) {
      const entry = CLASSIFICATION[name]
      if (entry?.catalog === undefined) continue
      expect([...entry.tools].sort(), name).toEqual(catalog.get(entry.catalog))
    }
  })

  it('mounts none of the packages that would load code into root dsh or start a root process for the model', () => {
    expect(names.filter(name => FORBIDDEN.includes(name))).toEqual([])
  })

  it('applies the containment rows', () => {
    const byId = (id: string) => rows.find(row => row.id === id)
    const subprocess = byId('subprocess')?.config as { runAs?: { set: Record<string, string>; secretNames: string[] }; shellActivityDirectory?: string; spillDirectory?: string }
    const runAs = subprocess.runAs
    expect(runAs?.set).toMatchObject({ HOME: '/home/agent', TMPDIR: '/home/agent/tmp' })
    expect(runAs?.secretNames).toEqual(expect.arrayContaining(['DEEPSEEK_API_KEY', 'MUMBO_MEMBER_KEY']))
    // /usr/local is root's alone, so agent installs npm packages under its own global prefix. Every directory on its PATH
    // is root's or agent's own: a project box's worker shims and gh wrapper first, as dsh-superagent sets them in its own
    // environment, then agent's npm and ~/.local/bin directories, then the system's.
    expect(runAs?.set.NPM_CONFIG_PREFIX).toBe('/home/agent/.npm-global')
    // gh keeps agent's sign-in outside every model and read-only root, where the file tools cannot read it.
    expect(runAs?.set.GH_CONFIG_DIR).toBe(AGENT_GH)
    expect(runAs?.set.PATH?.split(':')).toEqual([
      ...box === 'project' ? ['/var/lib/mumbo/superagent/worker-bin', '/usr/local/lib/mumbo/bin'] : [],
      '/home/agent/.npm-global/bin', '/home/agent/.local/bin', ...SYSTEM_PATH,
    ])
    // Shell activity records and command spill files leave dsh's root-only temporary directory for ones agent can reach.
    expect([subprocess.shellActivityDirectory, subprocess.spillDirectory]).toEqual(['/run/dsh-shell', '/var/lib/mumbo/subprocess-spill'])
    // /root/.mumbo stays 0700: no value a run-as child receives names a path inside it.
    expect(configStrings(subprocess).filter(value => value.includes('/root/.mumbo'))).toEqual([])
    const modelRoots = ['/root/projects', '/home/agent', box === 'person' ? '/home/shared/Downloads' : '/root/work']
    expect(byId('fs-sandbox')?.config).toEqual({
      modelRoots,
      readOnlyRoots: [
        '/var/lib/mumbo/attachments/attachments/v1', '/root/.dsh/skills', '/usr/local/share/mumbo/agents/skills', '/var/lib/mumbo/spill',
        '/var/lib/mumbo/subprocess-spill',
      ],
    })
    // The stores whose paths the model is told to read write where the read-only roots name, readable by agent's group.
    expect(byId('attachment-local')?.config).toEqual({ dshHome: '/var/lib/mumbo/attachments', groupReadable: true })
    expect(byId('spill-local')?.config).toEqual({ root: '/var/lib/mumbo/spill', groupReadable: true })
    const superagent = evaluated(byId('dsh-superagent')?.config, CONTAINMENT_ENV) as { workDirectory?: string; workerDirectory?: string; ghConfigDirectory?: string } | undefined
    if (box === 'project') {
      // Ticket directories sit in a model root, created as agent; the worker files and the orchestrator's gh configuration are root's.
      expect(superagent).toMatchObject({ workDirectory: '/root/work', workerDirectory: '/var/lib/mumbo/superagent', ghConfigDirectory: '/root/.config/gh' })
      expect(modelRoots).toContain('/root/work')
      // Workers receive the run-as environment, not dsh's, so it carries what dsh-superagent sets in its own.
      expect(runAs?.set).toMatchObject({ GIT_CONFIG_GLOBAL: '/var/lib/mumbo/superagent/worker-gitconfig', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' })
    }
    // Each of these must exist before dsh starts, so the documented box layout names every one.
    const layout = readFileSync(join(root, '.agents/notes/implemented/architecture/2026-11-10-agent-containment-run-as-and-model-roots.md'), 'utf8')
      .split('\n').find(line => line.startsWith('- Box layout the rows depend on')) ?? ''
    const { identities: named } = subprocess as { identities?: Record<string, { set: Record<string, string> }> }
    const serverHomes = SERVER_IDENTITIES[box].map(name => named?.[name]?.set.HOME)
    const consent = byId('browser-consent')?.config as { browser?: { outputDir?: string }; uploadDirectory?: string; uploadStaging?: string } | undefined
    const required = [...modelRoots, ...(byId('fs-sandbox')?.config as { readOnlyRoots: string[] }).readOnlyRoots, subprocess.shellActivityDirectory!, subprocess.spillDirectory!,
      ...serverHomes.map(home => home!), ...box === 'person' ? [consent!.browser!.outputDir!, consent!.uploadStaging!] : [],
      ...box === 'project' ? [superagent!.workerDirectory!, superagent!.ghConfigDirectory!] : []]
    expect(required.filter(path => !layout.includes(`\`${path}\``))).toEqual([])
    // The browser sends copies of files directly in the shared Downloads, which the model's tools reach as a model root,
    // staged in a directory only root writes.
    if (box === 'person') {
      expect([consent!.uploadDirectory, consent!.uploadStaging]).toEqual(['/home/shared/Downloads', '/var/lib/mumbo/uploads'])
      expect(modelRoots).toContain('/home/shared/Downloads')
      expect(modelRoots).not.toContain('/var/lib/mumbo/uploads')
      // The desktop tool waits for consent's service, so a consent row that fails to load leaves no ungated input.
      expect(byId('computer-use-x11')?.inject).toEqual(['mumbo-browser-consent'])
    }
    expect(byId('plugin-manager')?.config).toEqual({ modelTools: false })
    expect(byId('workspace-changes')?.config).toEqual({ summaries: false })
    expect(isDisabled(byId('preset-cordis')?.disabled)).toBe(true)
  })

  it('runs each named subprocess identity for exactly the packages classified with it, as a non-root user of its own', () => {
    const named = enabled.flatMap(row => namedIdentities(row.config).map(identity => `${row.name} as ${identity}`)).sort()
    const expected = enabled.flatMap((row) => {
      const entry = row.name === undefined ? undefined : CLASSIFICATION[row.name]
      const identity = entry?.identityFromRow === true ? (row.config as { identity?: string } | undefined)?.identity : entry?.identity
      if (identity === undefined || entry?.startsProcesses?.(row.config as Record<string, unknown> | undefined) === false) return []
      return [`${row.name} as ${identity}`]
    }).sort()
    expect(named).toEqual(expected)
    expect(named).toEqual(box === 'person'
      ? ['@deepseek-ai/dsh-computer-use-x11 as desktop', '@mumbo/box-links as desktop', '@mumbo/browser-consent as browsermcp']
      : [])
    type Identity = { uid: number; gid: number; groups: number[]; inherit: string[]; set: Record<string, string>; secretNames: string[] }
    const subprocess = rows.find(row => row.id === 'subprocess')?.config as { runAs: Identity; identities?: Record<string, Identity>; serverIdentity?: string }
    const identities = subprocess.identities ?? {}
    // The server identity is the provider's, not a row's: the MCP stdio servers that name none run as it.
    expect(subprocess.serverIdentity).toBe(SERVER_IDENTITY)
    expect(Object.keys(identities).sort()).toEqual([...new Set([...expected.map(entry => entry.split(' as ')[1]), SERVER_IDENTITY])].sort())
    const uids = [subprocess.runAs.uid, ...Object.values(identities).map(identity => identity.uid)]
    expect(uids.every(uid => uid > 0)).toBe(true)
    expect(new Set(uids).size).toBe(uids.length)
    for (const identity of Object.values(identities)) {
      expect(identity.secretNames).toEqual(expect.arrayContaining(['DEEPSEEK_API_KEY', 'MUMBO_MEMBER_KEY']))
    }
    // The person's server credentials reach no group another identity holds (`shared`, the workspace through agent's
    // group) while the box's mcpServerWorkspace switch is `none`, and its environment is the minimal base.
    const server = identities[SERVER_IDENTITY]!
    const others = [
      subprocess.runAs, ...Object.entries(identities).filter(([name]) => name !== SERVER_IDENTITY).map(([, identity]) => identity),
    ]
    const held = new Set(others.flatMap(identity => [identity.gid, ...identity.groups]))
    expect([server.gid, ...server.groups].filter(gid => held.has(gid))).toEqual([])
    expect(server.inherit).toEqual(['LANG'])
    expect(server.set).toEqual({ HOME: '/home/mcpserver', USER: 'mcpserver', PATH: '/usr/local/bin:/usr/bin:/bin' })
    // Each identity that runs a server starts it in its own home, which the provider checks, with only root's directories
    // on PATH and no NODE_PATH, so no model-writable directory supplies the code it runs.
    for (const name of SERVER_IDENTITIES[box]) {
      const identity = identities[name]!
      expect(identity.set.HOME, name).toBe(`/home/${name}`)
      expect(identity.set.PATH?.split(':').filter(directory => !SYSTEM_PATH.includes(directory)), name).toEqual([])
      expect(identity.inherit.filter(variable => ['PATH', 'NODE_PATH'].includes(variable)), name).toEqual([])
      expect(identity.set, name).not.toHaveProperty('NODE_PATH')
    }
    // The Playwright MCP server reads only the copies consent stages, and holds no workspace group or `shared`.
    if (box === 'person') expect(identities.browsermcp!.groups).toEqual([UPLOADS_GID])
  })

  it('starts no MCP stdio server as root', () => {
    const mcp = '@deepseek-ai/dsh-mcp-client'
    const added: Row[] = [
      { id: 'files', name: mcp, inject: ['subprocess'], config: { serverName: 'files', transport: 'stdio', command: 'npx', args: [] } },
      { id: 'remote', name: mcp, config: { serverName: 'remote', transport: 'streamable-http', url: 'https://mcp.example/mcp' } },
      { id: 'off', name: mcp, disabled: true, config: { serverName: 'off', transport: 'stdio', command: 'npx' } },
    ]
    // The person's servers come through the manager, which this box mounts.
    expect(enabled.find(row => row.name === '@deepseek-ai/dsh-mcp-manager')?.inject).toEqual(['credentials', 'subprocess'])
    expect(rootStdioServers([...rows, ...added])).toEqual([])
    // The check itself: without run-as on the provider, the manager and a stdio row naming no identity start servers as root,
    // and so do they without the injection, once the provider is gone.
    const unconfined = rows.map(row => row.id === 'subprocess' ? { ...row, config: { ...row.config as object, runAs: undefined } } : row)
    expect(rootStdioServers([...unconfined, ...added])).toEqual(['mcp-manager', 'files'])
    const unbound = rows.map(row => row.id === 'mcp-manager' ? { ...row, inject: ['credentials'] } : row)
    expect(rootStdioServers([...unbound, ...added, { ...added[0]!, id: 'loose', inject: undefined }])).toEqual(['mcp-manager', 'loose'])
    // Without the server identity they would run as another one, such as agent, whose shell the model drives.
    for (const serverIdentity of [undefined, 'agent']) {
      const shared = rows.map(row => row.id === 'subprocess' ? { ...row, config: { ...row.config as object, serverIdentity } } : row)
      expect(rootStdioServers([...shared, ...added])).toEqual(['mcp-manager', 'files'])
    }
  })

  it.runIf(box === 'project')('lists every orchestrator tool the superagent registers, and reads its directories from the start script\'s variables', async () => {
    const registered = await superagentTools()
    expect(CLASSIFICATION['@mumbo/superagent']!.tools).toEqual(registered)
    expect(registered).toContain('orchestrator_read')
    // No containment row patches it, which would replace the whole row: the composed row is the founder's overlay row.
    expect(edge('containment-project.overlay.yml').map(row => row.id)).not.toContain('dsh-superagent')
    const founder = deployed('mumbo-project.overlay.yml').filter(row => row.id === 'dsh-superagent' && row.config !== undefined).at(-1)?.config as object
    expect(rows.find(row => row.id === 'dsh-superagent')?.config).toEqual(founder)
    const directories = (env: Record<string, string>) => {
      const { workDirectory, workerDirectory, ghConfigDirectory } = evaluated(founder, env) as Record<string, unknown>
      return { workDirectory, workerDirectory, ghConfigDirectory }
    }
    expect(directories(CONTAINMENT_ENV)).toEqual({ workDirectory: '/root/work', workerDirectory: '/var/lib/mumbo/superagent', ghConfigDirectory: '/root/.config/gh' })
    // Without containment the start script exports none, and the plugin keeps its defaults.
    expect(directories({})).toEqual({ workDirectory: undefined, workerDirectory: undefined, ghConfigDirectory: undefined })
  })

  it('mounts no anonymous fetcher and sends web_fetch to the DeepSeek Fetch API at the edge\'s model host', { timeout: 60_000 }, async () => {
    const byId = (from: readonly Row[], id: string) => from.find(row => row.id === id)
    // The edge's model host, which the sandboxes server's URL names.
    const host = new URL((byId(rows, 'mcp-sandboxes')?.config as { url: string }).url).origin
    expect(isDisabled(byId(rows, 'web-fetch-http')?.disabled)).toBe(true)
    // The containment rows change only the fetch provider of the base's `web` row, whose search provider they restate.
    expect(byId(rows, 'web')?.config).toEqual({ ...byId(compose(box, false), 'web')?.config as object, fetchProvider: 'deepseek-fetch-api' })
    expect(byId(rows, 'web-deepseek-api')?.config).toEqual({ fetchBaseURL: `${host}/v1/tools` })

    // The composed rows in the real Loader: the box token goes only to the edge, whatever URL the model fetches.
    const sent: Array<{ endpoint: string; authorization: string | null; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn((endpoint: string, init?: RequestInit) => {
      sent.push({ endpoint, authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(init?.body as string) })
      return Promise.resolve(Response.json({ content: '# Page' }))
    }))
    const home = mkdtempSync(join(tmpdir(), 'dsh-box-containment-web-'))
    onTestFinished(() => {
      vi.unstubAllGlobals()
      rmSync(home, { recursive: true, force: true })
    })
    const config = join(home, 'cordis.yml')
    writeFileSync(config, JSON.stringify(['web', 'web-deepseek-api', 'web-fetch-http'].map(id => byId(rows, id))))
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-web', WebRuntime], ['@deepseek-ai/dsh-web-deepseek-api', WebDeepseekApi], ['@deepseek-ai/dsh-web-fetch-http', WebFetchHttp],
    ])
    const ctx: Context = await boot('box-containment-web', config, [], (host) => {
      host.loader.internal = {
        version: 'v2', loadCache: new Map(),
        import(specifier) { return Promise.resolve(modules.get(specifier)) },
        register(): never { throw new Error('Unexpected module hook registration') },
        getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
        resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
        load(): never { throw new Error('Unexpected module load') },
      } satisfies ModuleLoaderV2
      host.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { DEEPSEEK_API_KEY: 'box-token' } }]))
    })
    onTestFinished(() => ctx.fiber.dispose())
    expect(ctx.web.listProviders().fetch.map(provider => provider.id)).toEqual(['deepseek-fetch-api'])
    await ctx.web.fetch({ url: 'http://127.0.0.1:9222/json/list' })
    expect(sent).toEqual([{ endpoint: `${host}/v1/tools/fetch`, authorization: 'Bearer box-token', body: expect.objectContaining({ url: 'http://127.0.0.1:9222/json/list' }) as object }])
  })

  it.runIf(box === 'person')('classifies every model tool for turns a project\'s report started', async () => {
    // The door's tools serve the edge, never the box's model.
    const tools = names.filter(name => name !== '@mumbo/mcp').flatMap(name => CLASSIFICATION[name]?.tools ?? [])
    expect(Object.keys(REPORT_TURN).sort()).toEqual([...new Set(tools)].sort())
    // The package is private and not a dependency of this app; its source is loaded from the repository.
    const { runsUnasked } = await import(pathToFileURL(join(root, 'packages/mumbo/mcp/src/report-turns.ts')).href) as { runsUnasked: (name: string, args: unknown) => boolean }
    // A family is checked through one member, the browser's through a read and a write.
    const member = (tool: string, name: string) => runsUnasked(tool.replace(/\*$/u, name), {})
    for (const [tool, runs] of Object.entries(REPORT_TURN)) {
      if (runs === 'browser reads run') expect([member(tool, 'browser_snapshot'), member(tool, 'browser_click')], tool).toEqual([true, false])
      else expect(member(tool, 'example'), tool).toBe(runs === 'runs')
    }
  })

  it.runIf(box === 'person' && process.platform === 'linux')('keeps agent\'s GitHub sign-in out of the file tools\' reach', async () => {
    const { modelRoots, readOnlyRoots } = rows.find(row => row.id === 'fs-sandbox')?.config as { modelRoots: string[]; readOnlyRoots: string[] }
    // The box's directories, rebuilt under a temporary directory.
    const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-box-containment-gh-')))
    onTestFinished(() => rm(base, { recursive: true, force: true }))
    const at = (path: string) => join(base, path)
    for (const directory of [...modelRoots, ...readOnlyRoots, AGENT_GH]) await mkdir(at(directory), { recursive: true })
    await writeFile(at(join(AGENT_GH, 'hosts.yml')), 'github.com: {}\n')
    await writeFile(at('/home/agent/notes.txt'), 'notes\n')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(LocalFileSystem, { modelRoots: modelRoots.map(at), readOnlyRoots: readOnlyRoots.map(at) })
    expect((await ctx.fs.resolveModelPath(at('/home/agent/notes.txt'))).displayPath).toBe(at('/home/agent/notes.txt'))
    await expect(ctx.fs.resolveModelPath(at(join(AGENT_GH, 'hosts.yml')))).rejects.toMatchObject({ code: 'FS_OUTSIDE_ROOTS' })
  })

  it.runIf(box === 'person')('lists every tool the door to Mumbo serves, with the ones that run git as agent', async () => {
    const mcp = enabled.filter(row => row.name === '@mumbo/mcp')
    expect(mcp.map(row => (row.config as { profile?: string }).profile)).toEqual(['door'])
    const { tools, runAsTools } = CLASSIFICATION['@mumbo/mcp']!
    expect([...tools, ...runAsTools ?? []].sort()).toEqual(await doorTools())
    // The door serves no halt or resume of the person's runs.
    expect(await doorTools()).not.toContain('runs_halt')
  })

  it.runIf(box === 'person')('lists every tool @mumbo/state registers', async () => {
    expect(CLASSIFICATION['@mumbo/state']!.tools).toEqual(await stateTools())
  })

  it('lists every mounted model tool with how it runs', () => {
    const table = names.flatMap((name) => {
      const { runs, identity, tools = [], runAsTools = [] } = CLASSIFICATION[name] ?? {}
      return [
        ...tools.map(tool => `${tool} — ${String(runs)}${identity === undefined ? '' : ` as ${identity}`} (${name})`),
        ...runAsTools.map(tool => `${tool} — run-as (${name})`),
      ]
    })
    expect(table).toEqual(expect.arrayContaining(box === 'person'
      ? ['computer — run-as as desktop (@deepseek-ai/dsh-computer-use-x11)', 'mcp__playwright-mcp__* — run-as as browsermcp (@mumbo/browser-consent)',
        'agent_send — in-process (@mumbo/mcp)', 'task_result — run-as (@mumbo/mcp)', 'task_status — run-as (@mumbo/mcp)']
      : ['bash — run-as (@deepseek-ai/dsh-tool-bash)']))
    if (box === 'project') expect(table).toEqual(expect.arrayContaining(['orchestrator_read — in-process (@mumbo/superagent)']))
  })
})
