/**
 * Containment gate over the mumbo box compositions: the web profile, the founder's overlays, the rows the edge writes,
 * and the edge's containment rows (fixtures/box-edge). Every mounted package is classified by how its model-visible
 * tools run; an unclassified package fails, catalogued tool names must match, the packages that would load code into
 * root dsh or start a root process for the model must be switched off or absent, every subprocess identity a row
 * names must be the one its classification expects and a configured non-root identity of its own, every MCP stdio
 * server that names no identity must start as the dedicated `mcpserver` identity, never as root or `agent`, the
 * project box's `dsh-superagent` row is the founder's overlay row, read with the directories the start script exports,
 * `agent`'s PATH names only root's directories and its own npm global prefix and ~/.local/bin, and `web_fetch` goes
 * to the DeepSeek Fetch API, and `web_search` to the DeepSeek Search API, at the edge's model host. Every listed package
 * must exist in the workspace, every row new in an upstream release is off under root unless a ruling turns it on, no
 * enabled row waits for a service only an off row registers, and the Web rows print one launch line with the token and
 * serve nothing under `/pairing/`. The person box includes the door to Mumbo (`@mumbo/mcp`), whose
 * tools the edge calls for the person, Run Wild (`@mumbo/run-wild`), and the state block (`@mumbo/state`), which the
 * project overlay mounts in project boxes too.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  boot, composeEntries, loadOverlayPatches, loadProfile, readProfileDenyList, readProfileManifest, readProfilePatches, renderConfigDump,
  resolveTelemetryPatch, writeProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import * as DeepSeekAuth from '@deepseek-ai/dsh-deepseek-auth'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebDeepseekApi from '@deepseek-ai/dsh-web-deepseek-api'
import * as WebFetchHttp from '@deepseek-ai/dsh-web-fetch-http'

const root = resolve(import.meta.dirname, '../../..')
const installAnchor = fileURLToPath(new URL('../package.json', import.meta.url))
const deployed = (name: string) => loadOverlayPatches('dsh', join(root, 'deploy', name))
const edge = (name: string) => loadOverlayPatches('dsh', join(import.meta.dirname, 'fixtures/box-edge', name))
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
  '@deepseek-ai/cordis-plugin-logger-console': { ...NONE, note: 'writes the Host\'s warn and error log lines to stdout' },
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
  '@deepseek-ai/dsh-deepseek-auth': {
    ...NONE, note: 'orders the API key for DeepSeek requests; it goes only to the origin DEEPSEEK_BASE_URL names, the edge\'s model host',
  },
  '@deepseek-ai/dsh-deepseek-llm-api-extensions': NONE,
  '@deepseek-ai/dsh-deliverable-file-references': NONE,
  '@deepseek-ai/dsh-file-reference-local': NONE,
  '@deepseek-ai/dsh-fs-sandbox': NONE,
  '@deepseek-ai/dsh-goal': NONE,
  '@deepseek-ai/dsh-goal-round-driver': NONE,
  '@deepseek-ai/dsh-hmr': NONE,
  '@deepseek-ai/dsh-hooks-claude-code': { ...NONE, note: 'ruling #4: hook commands run through the shell, so as `agent`' },
  '@deepseek-ai/dsh-host-authentication-token': { ...NONE, note: 'the launch token and owner cookie; prints the one `dsh web:` line the edge reads' },
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
  '@deepseek-ai/dsh-office-kit': {
    runs: 'run-as', tools: [], note: 'conversions, the previews the person opens included, run in a helper as the run-as identity',
  },
  '@deepseek-ai/dsh-otel': NONE,
  '@deepseek-ai/dsh-permission-presets': NONE,
  '@deepseek-ai/dsh-persona': NONE,
  '@deepseek-ai/dsh-plan-mode': { runs: 'in-process', tools: ['exit_plan_mode'], catalog: '@deepseek-ai/dsh-plan-mode' },
  '@deepseek-ai/dsh-plugin-manager/deny-list': { ...NONE, note: 'carries the deny list; registers nothing' },
  '@deepseek-ai/dsh-plugin-manager': { ...NONE, note: 'the service; its model tool is the /tools row, which is forbidden' },
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
  '@deepseek-ai/dsh-skill-office': { ...NONE, note: 'Office skill text the skill tool loads' },
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
  '@deepseek-ai/dsh-tool-office': {
    runs: 'run-as', tools: ['office_convert', 'office_recalculate', 'office_render'], catalog: '@deepseek-ai/dsh-tool-office',
    note: 'inputs resolve and read through the model roots as read does; office-kit converts as the run-as identity into a read-only root',
  },
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
  '@mumbo/edge-member/project-workspace': NONE,
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
 * Packages no box may mount, each with the reason: they load code into root dsh, start a root process for the model, send
 * root dsh's requests to any address the model names, loopback and private ones included, or are rows new in an upstream
 * release that no ruling has turned on for boxes.
 */
const FORBIDDEN: Readonly<Record<string, string>> = {
  '@deepseek-ai/dsh-tool-cordis': 'inspects the Host and loads code into root dsh',
  '@deepseek-ai/dsh-plugin-market/tools': 'installs plugins, which loads code into root dsh',
  '@deepseek-ai/dsh-plugin-manager/tools': 'installs and enables plugins, which loads code into root dsh; the manager also withholds the tool (`modelTools: false`)',
  '@deepseek-ai/dsh-subagent-dsh-sdk': 'starts a child dsh as root under its own profile',
  '@deepseek-ai/dsh-web-fetch-http': 'fetches from root dsh, outside the agent network rules',
  '@deepseek-ai/dsh-client-remote-connection': 'its anonymous `/` and `/pairing/*` routes and owner-cookie Provider are a second way to become the owner',
  '@deepseek-ai/dsh-tool-session-control': 'a member\'s turn could write into any other Session of a project box',
  '@deepseek-ai/dsh-mcp-account': 'connector accounts sign in through an OAuth callback route on the box',
  '@deepseek-ai/dsh-cli-account': 'starts vendor CLIs in dsh\'s own home directory, which fails under run-as',
  '@deepseek-ai/dsh-client-ui-connector-account': 'the account sections of mcp-account and cli-account, which are off',
  '@deepseek-ai/dsh-upstream-skills': 'downloads skill files for CLI app plugins, which no box mounts',
  '@deepseek-ai/dsh-creation-recommendations': 'starts a subagent under the creator preset, whose tool-cordis is forbidden',
  '@deepseek-ai/dsh-client-ui-creation-recommendations': 'the cards of creation-recommendations, which is off',
  '@deepseek-ai/dsh-action-cards': 'its experimental predecessor was not mounted on boxes; only the recommendation rows use it',
  '@deepseek-ai/dsh-client-ui-action-cards': 'its experimental predecessor was not mounted on boxes',
  '@deepseek-ai/dsh-plugin-recommendations': 'its experimental predecessor was not mounted on boxes; its cards offer plugins to install',
  '@deepseek-ai/dsh-client-ui-plugin-recommendations': 'its experimental predecessor was not mounted on boxes',
  '@deepseek-ai/dsh-host-authentication-desktop': 'admits the desktop shell\'s window as the owner; a box has only the launch token',
  '@deepseek-ai/dsh-session-persistence-sqlite': 'boxes stay on JSONL: the import is one-way (later events live only in SQLite, and the retained JSONL '
    + 'cannot restore them) and backups do not cover `<root>/.segments/sessions.sqlite`',
  '@deepseek-ai/dsh-deepseek-chat-import': 'parses an uploaded DeepSeek chat export in root dsh and stores it as Sessions; no ruling turns it on',
  '@deepseek-ai/dsh-experimental-worktree': 'its Host operations move a Session to a directory the model influences, outside resolveModelPath',
  '@deepseek-ai/dsh-experimental-tool-worktree': 'its tools ask the worktree Host operations for a directory the model names',
  '@deepseek-ai/dsh-experimental-forge-bundle': 'the bundle that mounts the worktree and forge rows',
  '@deepseek-ai/dsh-experimental-client-ui-forge': 'its panel continues a Session in a project the model influences, outside resolveModelPath',
}

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
  office_convert: 'asks',
  office_recalculate: 'asks',
  office_render: 'asks',
  plan_read: 'runs',
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
  write: 'asks',
}

/** The directories a contained project box's start script exports for the project overlay's `dsh-superagent` row. */
const CONTAINMENT_ENV = { MUMBO_WORK_DIR: '/root/work', MUMBO_WORKER_DIR: '/var/lib/mumbo/superagent', MUMBO_GH_CONFIG_DIR: '/root/.config/gh' }

/**
 * Evaluate `!!js` values in a row's field the way a contained Linux box boots it: dsh runs as root (uid 0), the launcher
 * supplies a profile context, `dshHomePath` names a path under root's DSH home, and `env` is the environment. Another
 * `uid` evaluates the value for a dsh that does not run as root.
 */
function evaluated(value: unknown, env: Record<string, string> = {}, uid = 0): unknown {
  if (Array.isArray(value)) return value.map(entry => evaluated(entry, env, uid))
  if (typeof value !== 'object' || value === null) return value
  if (!('__jsExpr' in value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, evaluated(entry, env, uid)]))
  const context = { get: (name: string) => (name === 'profileContext' ? {} : undefined) }
  // The expressions are the repository's own composition files.
  // oxlint-disable-next-line typescript/no-implied-eval
  const evaluate = new Function('ctx', 'process', 'dshHomePath', `return (${String(value.__jsExpr)})`) as (ctx: unknown, process: unknown, home: unknown) => unknown
  return evaluate(context, { platform: 'linux', env, getuid: () => uid }, (name: string) => `/root/.dsh/${name}`)
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

/**
 * The overlay files a box starts with after its bundles, in order: the founder's, the rows the edge writes, for a person
 * box the overlays the edge patches in for the door to Mumbo, Run Wild and the state block, and the edge's containment
 * rows last unless `contained` is false.
 */
function overlayPaths(box: 'person' | 'project', contained = true): string[] {
  const fixture = (name: string) => join(import.meta.dirname, 'fixtures/box-edge', name)
  return [
    join(root, 'deploy/mumbo.overlay.yml'), join(root, 'deploy/mumbo-personal.overlay.yml'),
    ...box === 'person'
      ? [fixture('personal.overlay.yml'), ...['mcp', 'run-wild', 'state'].map(name => join(root, `packages/mumbo/${name}/examples/person.overlay.yml`))]
      : [fixture('project.overlay.yml'), join(root, 'deploy/mumbo-project.overlay.yml')],
    ...contained ? [fixture(`containment-${box}.overlay.yml`)] : [],
  ]
}

/** The box's composed rows, with the edge's containment rows unless `contained` is false, and `bundles` as layers a person switched on. */
function compose(
  box: 'person' | 'project', contained = true, bundles: readonly ReturnType<typeof loadOverlayPatches>[] = [],
): ReturnType<typeof composeEntries> {
  const home = mkdtempSync(join(tmpdir(), 'dsh-box-containment-'))
  try {
    const profile = loadProfile('dsh', 'web', installAnchor, home)
    const warnings: string[] = []
    const rows = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
      ...bundles,
      ...overlayPaths(box, contained).map(path => loadOverlayPatches('dsh', path)),
    ], message => warnings.push(message))
    expect(warnings).toEqual([])
    return rows
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

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

/** A workspace package: its directory and the subpaths its manifest exports. */
interface WorkspacePackage { dir: string; exports: readonly string[] }

/** Every workspace package under `vendor/` and `packages/<group>/`, by name. */
function workspacePackages(): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>()
  const directories = (path: string) => readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => join(path, entry.name))
  for (const dir of [join(root, 'vendor'), ...directories(join(root, 'packages'))].flatMap(directories)) {
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const { name, exports } = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; exports?: unknown }
    packages.set(name, { dir, exports: typeof exports === 'object' && exports !== null ? Object.keys(exports) : ['.'] })
  }
  return packages
}

/** The package and export subpath a row name or a list entry names, such as `@deepseek-ai/dsh-plugin-market/tools`. */
function specifier(name: string): { packageName: string; subpath: string } {
  const [scope, base, ...rest] = name.split('/')
  return { packageName: `${scope!}/${base!}`, subpath: rest.length === 0 ? '.' : `./${rest.join('/')}` }
}

/** Whether `name` is a workspace package, or a subpath one exports. */
function resolvesInWorkspace(name: string, packages: ReadonlyMap<string, WorkspacePackage>): boolean {
  const { packageName, subpath } = specifier(name)
  return packages.get(packageName)?.exports.includes(subpath) === true
}

/** Every row at any depth, groups and agent presets included, with whether it or a row above it is off on a box. */
function allRows(rows: readonly Row[], above = false): { row: Row; off: boolean }[] {
  return rows.flatMap((row) => {
    const off = above || isDisabled(row.disabled)
    const children = row.name === 'cordis:group' && Array.isArray(row.config) ? row.config as Row[]
      : row.name === '@deepseek-ai/dsh-agent-preset' ? (row.config as { plugins: Row[] }).plugins : []
    return [{ row, off }, ...allRows(children, off)]
  })
}

/** Every `.ts` and `.tsx` source text under a package's `src`. */
function sources(dir: string): string[] {
  const src = join(dir, 'src')
  if (!existsSync(src)) return []
  return readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/u.test(file)).map(file => readFileSync(join(src, file), 'utf8'))
}

/** Service names a package's sources register: a Service constructor's name, or a `provide` or `set` call's. */
function providedServices(dir: string): string[] {
  return sources(dir).flatMap(text => [...text.matchAll(/(?:super\(\s*\w+,|\.(?:provide|set)\()\s*'([\w.]+)'/gu)].map(match => match[1]!))
}

/** Service names a package's sources declare in a plugin's static `inject` list. */
function injectedServices(dir: string): string[] {
  return sources(dir).flatMap(text => [...text.matchAll(/\binject(?::[^=\n]+)?\s*=\s*\[([^\]]*)\]/gu)]
    .flatMap(match => [...match[1]!.matchAll(/'([\w.]+)'/gu)].map(name => name[1]!)))
}

/** The rows new since upstream 0.2.3-alpha.2 that are off on a box, by id; each package is in {@link FORBIDDEN}. */
const OFF_ROWS = [
  'cli-account', 'upstream-skills', 'tool-session-control', 'mcp-account', 'remote-connection', 'ui-connector-account', 'action-cards',
  'client-ui-action-cards', 'creation-recommendations', 'client-ui-creation-recommendations', 'plugin-recommendations', 'client-ui-plugin-recommendations',
]

/**
 * What the base bundle's `plugin-deny-list` row denies where dsh runs as root: the optional bundles that mount a
 * {@link FORBIDDEN} package, and the {@link OFF_ROWS} that nobody may switch on.
 */
const DENY_LIST = {
  bundles: ['@deepseek-ai/dsh-experimental-forge-bundle', '@deepseek-ai/dsh-experimental-tool-worktree', '@deepseek-ai/dsh-deepseek-chat-import'],
  rows: ['remote-connection', 'cli-account', 'upstream-skills'],
}

/** The rows new since upstream 0.2.3-alpha.2 that are on in a box, by id. */
const ON_ROWS = ['deepseek-auth', 'authentication-token', 'ui-session-status', 'ui-session-panel']

describe('the containment lists', () => {
  it('name only workspace packages and the subpaths they export', () => {
    const packages = workspacePackages()
    // A renamed or deleted package would otherwise leave its entry matching no row, and the gate would pass without it.
    expect([...Object.keys(CLASSIFICATION), ...Object.keys(FORBIDDEN)].filter(name => !resolvesInWorkspace(name, packages))).toEqual([])
    expect(Object.keys(CLASSIFICATION).filter(name => name in FORBIDDEN)).toEqual([])
  })

  it('finds a box with the telemetry switch set by its image and by its start script', () => {
    const SWITCH = /\bDSH_TELEMETRY_DISABLED=1\b/u
    for (const file of ['deploy/Dockerfile', 'deploy/boxes/edge/edge.mjs', 'deploy/boxes/trial/box.mjs']) {
      expect(readFileSync(join(root, file), 'utf8'), file).toMatch(SWITCH)
    }
  })
})

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
    expect(names.filter(name => name in FORBIDDEN)).toEqual([])
    // The Office tools, previews and skill are on; office-kit converts as the run-as identity.
    expect(names).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-office-kit', '@deepseek-ai/dsh-skill-office', '@deepseek-ai/dsh-tool-office']))
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
        '/var/lib/mumbo/subprocess-spill', '/var/lib/mumbo/office-outputs',
      ],
    })
    // The stores whose paths the model is told to read write where the read-only roots name, readable by agent's group.
    expect(byId('attachment-local')?.config).toEqual({ dshHome: '/var/lib/mumbo/attachments', groupReadable: true })
    expect(byId('spill-local')?.config).toEqual({ root: '/var/lib/mumbo/spill', groupReadable: true })
    expect(byId('office-kit')?.config).toEqual({ outputDirectory: '/var/lib/mumbo/office-outputs', groupReadable: true })
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
    // A patch replaces a row's whole config, so no overlay of a box may patch the row that carries the deny list.
    expect(overlayPaths(box).filter(path => loadOverlayPatches('dsh', path).some(patch => JSON.stringify(patch).includes('"plugin-deny-list"')))).toEqual([])
    // A config patch of a preset would replace its whole plugin list, and with it the root switches on tool-cordis and tool-plugin-manager.
    const presetPatches = overlayPaths(box).filter(path => (loadOverlayPatches('dsh', path) as Row[])
      .some(patch => (patch.id === 'preset-standard' || patch.id === 'preset-ptc') && 'config' in patch))
    expect(presetPatches).toEqual([])
    expect(evaluated(byId('plugin-deny-list')?.config)).toEqual(DENY_LIST)
    expect(evaluated(byId('plugin-deny-list')?.config, {}, 1000)).toEqual({ bundles: [], rows: [] })
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

  it('keeps each row new in upstream 0.2.3-alpha.2 off unless a ruling turns it on', () => {
    const byId = (id: string) => rows.find(row => row.id === id)
    for (const id of OFF_ROWS) {
      expect(byId(id), id).toBeDefined()
      expect(isDisabled(byId(id)?.disabled), id).toBe(true)
      expect(FORBIDDEN, id).toHaveProperty([byId(id)!.name])
    }
    for (const id of ON_ROWS) expect(isDisabled(byId(id)?.disabled), id).toBe(false)
    // The connector accounts and the creator tools are off together: neither mcp-account nor any tool-cordis row runs.
    const cordis = allRows(rows).filter(({ row }) => row.name === '@deepseek-ai/dsh-tool-cordis')
    expect(cordis.length).toBeGreaterThan(0)
    expect([isDisabled(byId('mcp-account')?.disabled), ...cordis.map(({ off }) => off)]).not.toContain(false)
    // The founder's overlay still switches the DeepSeek account off by its row id.
    expect(byId('deepseek-account')?.name).toBe('@deepseek-ai/dsh-deepseek-account')
    expect(deployed('mumbo.overlay.yml')).toContainEqual({ id: 'deepseek-account', disabled: true })
    expect(isDisabled(byId('deepseek-account')?.disabled)).toBe(true)
    // The launcher switches session telemetry off for the variable the box sets.
    expect(resolveTelemetryPatch('1', byId('session-telemetry-otel') !== undefined)).toEqual({ id: 'session-telemetry-otel', disabled: true })
  })

  it('mounts no worktree or forge row, in any state', () => {
    const packages = workspacePackages()
    const bundled = ['@deepseek-ai/dsh-experimental-forge-bundle', '@deepseek-ai/dsh-experimental-tool-worktree'].flatMap((bundle) => {
      const patches = loadOverlayPatches('dsh', join(packages.get(bundle)!.dir, 'cordis.patch.yml')) as { insert?: Row[] }[]
      return patches.flatMap(patch => patch.insert ?? [])
    })
    expect(bundled.map(row => row.id)).toEqual(expect.arrayContaining(['worktree', 'tool-worktree', 'forge-panel']))
    const mounted = allRows(rows).map(({ row }) => row)
    const fromBundle = (row: Row) => bundled.some(candidate => candidate.id === row.id || candidate.name === row.name)
    expect(mounted.filter(fromBundle).map(row => row.id)).toEqual([])
  })

  it('names only modules the workspace resolves, and leaves no enabled row waiting for a service of a row that is off', () => {
    const packages = workspacePackages()
    const every = allRows(rows).filter(({ row }) => row.name !== undefined && !row.name.startsWith('cordis:'))
    expect(every.filter(({ row, off }) => !off && !resolvesInWorkspace(row.name!, packages)).map(({ row }) => row.name)).toEqual([])
    const directory = (row: Row) => packages.get(specifier(row.name!).packageName)!.dir
    const on = every.filter(({ off }) => !off).map(({ row }) => row)
    const kept = new Set(on.map(directory).flatMap(providedServices))
    const withheld = new Set(every.filter(({ off, row }) => off && resolvesInWorkspace(row.name!, packages))
      .flatMap(({ row }) => providedServices(directory(row))).filter(service => !kept.has(service)))
    // The scan reads the services the off rows register: the ones the rulings name must be among them.
    expect([...withheld]).toEqual(expect.arrayContaining(['actionCards', 'cliAccounts', 'connectorAccounts', 'mcpAccounts', 'upstreamSkills']))
    const waiting = on.flatMap((row) => {
      const needs = [...Array.isArray(row.inject) ? row.inject as string[] : [], ...injectedServices(directory(row))]
      return needs.filter(service => withheld.has(service)).map(service => `${row.id!} waits for ${service}`)
    })
    expect(waiting).toEqual([])
  })

  it('denies every installed optional bundle that would mount a forbidden package', async () => {
    const packages = workspacePackages()
    // The package is not a dependency of this app; its source is loaded from the repository.
    const bundles = pathToFileURL(join(root, 'packages/util/official-bundles/src/bundles.ts')).href
    const { OPTIONAL_BUNDLES } = await import(bundles) as { OPTIONAL_BUNDLES: readonly string[] }
    const installed = JSON.parse(readFileSync(installAnchor, 'utf8')) as { dependencies: Record<string, string> }
    const { bundles: deniedBundles } = evaluated(rows.find(row => row.id === 'plugin-deny-list')?.config) as typeof DENY_LIST
    const mountsForbidden: string[] = []
    for (const bundle of OPTIONAL_BUNDLES.filter(name => name in installed.dependencies)) {
      const { dir } = packages.get(bundle)!
      const { patch } = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dsh: { bundle: { patch: string | string[] } } }).dsh.bundle
      const layer = [patch].flat().flatMap(file => loadOverlayPatches('dsh', join(dir, file)))
      const mounted = enabledRows(compose(box, true, [layer])).map(row => row.name)
      if (bundle in FORBIDDEN || mounted.some(name => name !== undefined && name in FORBIDDEN)) mountsForbidden.push(bundle)
    }
    // Profile composition and the plugin manager both read this list: a listed bundle contributes no rows and cannot be enabled.
    expect(mountsForbidden.filter(bundle => !deniedBundles.includes(bundle))).toEqual([])
    expect([...deniedBundles].sort()).toEqual([...mountsForbidden].sort())
  })

  it('denies the rows that nobody may switch on, each off in the box and forbidden', () => {
    const { rows: deniedRows } = evaluated(rows.find(row => row.id === 'plugin-deny-list')?.config) as typeof DENY_LIST
    expect([...deniedRows].sort()).toEqual([...DENY_LIST.rows].sort())
    for (const id of deniedRows) {
      const row = rows.find(candidate => candidate.id === id)
      expect(OFF_ROWS, id).toContain(id)
      expect(isDisabled(row?.disabled), id).toBe(true)
      expect(FORBIDDEN, id).toHaveProperty([row!.name])
    }
  })

  it('keeps the deny list and the root switches in effect under the edge\'s own rows, in a profile that already enables a listed bundle and row', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-box-containment-'))
    onTestFinished(() => { rmSync(home, { recursive: true, force: true }) })
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0)
    onTestFinished(() => { getuid.mockRestore() })
    const profile = loadProfile('dsh', 'web', installAnchor, home)
    const manifest = readProfileManifest('dsh', profile.dir)
    const selected = manifest.dsh!.profile!.bundles!
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...selected, '@deepseek-ai/dsh-experimental-forge-bundle'] } }
    writeProfileManifest(profile.dir, manifest)
    // What `setPluginEnabled` writes, and an edge-style config patch of two rows the bundles switch off under root.
    writeFileSync(profile.patchPath, '- id: remote-connection\n  disabled: false\n- id: mcp-account\n  disabled: false\n')
    const hazard = join(home, 'config-patch.overlay.yml')
    writeFileSync(hazard, '- id: remote-connection\n  config: {}\n- id: cli-account\n  config: {}\n')
    const context = {
      name: 'web', dir: profile.dir, patchPath: profile.patchPath, installAnchor, home, cwd: home, telemetryDisabledEnv: undefined,
      startedBundles: [...selected, '@deepseek-ai/dsh-experimental-forge-bundle'], overlayPaths: [...overlayPaths(box), hazard],
    }
    // The edge's own `plugin-manager` row is among the overlays and does not reach the list.
    expect(loadOverlayPatches('dsh', overlayPaths(box).at(-1)!)).toContainEqual({ id: 'plugin-manager', config: { modelTools: false } })
    expect(readProfileDenyList('dsh', context)).toEqual({ ...DENY_LIST, dropped: ['@deepseek-ai/dsh-experimental-forge-bundle', 'remote-connection'] })
    const composed = composeEntries([readProfilePatches('dsh', context)]) as Row[]
    expect(composed.find(row => row.id === 'plugin-manager')?.config).toEqual({ modelTools: false })
    expect(composed.filter(row => ['worktree', 'tool-worktree', 'forge', 'forge-panel'].includes(row.id!)).map(row => row.id)).toEqual([])
    // The entry-level switch is not part of `config`, so a config patch of the same row leaves it.
    for (const id of ['remote-connection', 'cli-account']) {
      const row = composed.find(candidate => candidate.id === id)
      expect(row?.config, id).toEqual({})
      expect(row?.disabled, id).toEqual({ __jsExpr: 'process.getuid?.() === 0' })
      expect(isDisabled(row?.disabled), id).toBe(true)
    }
    // A row that is off by default only is the owner's to switch on.
    expect(composed.find(row => row.id === 'mcp-account')?.disabled).toBe(false)
    // A dsh that does not run as root reads an empty list and keeps the profile's own choices.
    getuid.mockReturnValue(1000)
    expect(readProfileDenyList('dsh', context)).toEqual({ bundles: [], rows: [], dropped: [] })
    const desktop = composeEntries([readProfilePatches('dsh', context)]) as Row[]
    expect(desktop.find(row => row.id === 'remote-connection')?.disabled).toBe(false)
    expect(desktop.map(row => row.id)).toEqual(expect.arrayContaining(['worktree', 'forge-panel']))
  })

  it('prints one launch line with the token, and serves nothing under /pairing/', { timeout: 60_000 }, async () => {
    // The box's own rows for the Web listener, sign-in and entry line, in the real Loader, each off where a root dsh has
    // it off, started with the flags the edge's start script passes.
    const WEB = ['credentials', 'web-startup', 'webserver', 'web-runtime', 'connection', 'authentication-token', 'remote-connection']
    const served = async (remoteConnection: boolean): Promise<{ printed: string[]; pairing: number[] }> => {
      const home = mkdtempSync(join(tmpdir(), 'dsh-box-containment-entry-'))
      vi.stubEnv('DSH_HOME', home)
      writeFileSync(join(home, 'index.html'), '<!doctype html><title>dsh</title>')
      const web = await import('@deepseek-ai/dsh-web-app')
      vi.spyOn(web.internals, 'resolveDistIndex').mockReturnValue(join(home, 'index.html'))
      const printed: string[] = []
      vi.spyOn(console, 'log').mockImplementation((line: string) => { printed.push(line) })
      const selected = WEB.map(id => rows.find(row => row.id === id)!)
        .map(row => ({ ...row, disabled: row.id === 'remote-connection' ? !remoteConnection : isDisabled(row.disabled) }))
      writeFileSync(join(home, 'base.yml'), '[]\n')
      const config = join(home, 'cordis.yml')
      writeFileSync(config, renderConfigDump('dsh', join(home, 'base.yml'), [{ label: 'box', patches: [{ insert: selected }] }], () => {}))
      const ctx: Context = await boot('box-containment-entry', config, [], (host) => {
        host.loader.internal = {
          version: 'v2', loadCache: new Map(),
          import(specifier) { return import(/* @vite-ignore */ specifier) },
          register(): never { throw new Error('Unexpected module hook registration') },
          getOrCreateModuleJob(): never { throw new Error('Unexpected module job creation') },
          resolveSync(): never { throw new Error('Unexpected synchronous module resolution') },
          load(): never { throw new Error('Unexpected module load') },
        } satisfies ModuleLoaderV2
        host.provide('launchEnvironment', createLaunchEnvironmentSnapshot([]))
        const flags = ['--no-open', '--host', '127.0.0.1', '--port', '0', '--public-url', 'https://app.example/', '--trusted-host', 'app.example']
        host.provide('cmdlineArgs', { get: () => flags })
        host.provide('appExit', () => { throw new Error('Unexpected exit request') })
      })
      try {
        await vi.waitFor(() => { expect(printed.length).toBeGreaterThan(0) })
        const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
        const status = async (path: string) => (await fetch(`${origin}${path}`, { redirect: 'manual' })).status
        return { printed, pairing: [await status('/pairing/'), await status('/pairing/client.js')] }
      } finally {
        await ctx.fiber.dispose()
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        rmSync(home, { recursive: true, force: true })
      }
    }
    const { printed, pairing } = await served(false)
    // The edge reads the token with `grep -o 'token=[A-Za-z0-9_-]*' /root/dsh.log | tail -1`.
    const lines = printed.filter(line => line.includes('token='))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^dsh web: https:\/\/app\.example\/\?token=[A-Za-z0-9_-]+$/u)
    expect(pairing.filter(status => status !== 401 && status !== 404)).toEqual([])
    // The check itself: with the remote-connection row on, as for a non-root dsh, the pairing page's script is served.
    expect((await served(true)).pairing[1]).toBe(200)
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
    // The base pins only its anonymous fetcher and leaves search to the model route; the containment rows pin both, so a
    // search uses the DeepSeek Search API on every model route.
    expect(byId(compose(box, false), 'web')?.config).toEqual({ fetchProvider: 'http' })
    expect(byId(rows, 'web')?.config).toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
    expect(byId(rows, 'web-deepseek-api')?.config).toEqual({ fetchBaseURL: `${host}/v1/tools` })

    // The composed rows in the real Loader: the box token goes only to the edge, whatever URL the model fetches.
    const sent: Array<{ endpoint: string; authorization: string | null; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn((endpoint: string, init?: RequestInit) => {
      sent.push({ endpoint, authorization: new Headers(init?.headers).get('authorization'), body: JSON.parse(init?.body as string) })
      return Promise.resolve(Response.json(endpoint.endsWith('/search') ? { results: [] } : { content: '# Page' }))
    }))
    const home = mkdtempSync(join(tmpdir(), 'dsh-box-containment-web-'))
    onTestFinished(() => {
      vi.unstubAllGlobals()
      rmSync(home, { recursive: true, force: true })
    })
    const config = join(home, 'cordis.yml')
    writeFileSync(config, JSON.stringify(['deepseek-auth', 'web', 'web-deepseek-api', 'web-fetch-http'].map(id => byId(rows, id))))
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-deepseek-auth', DeepSeekAuth], ['@deepseek-ai/dsh-web', WebRuntime], ['@deepseek-ai/dsh-web-deepseek-api', WebDeepseekApi],
      ['@deepseek-ai/dsh-web-fetch-http', WebFetchHttp],
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

    // A search goes to the same host on both model routes. The API-key route (`llm-deepseek`) connects the deployment
    // DEEPSEEK_BASE_URL names, which the box's start script points at the edge; this stands in for that row.
    ctx.effect(() => ctx.deepseekAuth.connect('api-key', 'deepseek-official', () => ({ baseURL: `${host}/anthropic` })), 'box-containment: API-key deployment')
    expect(ctx.web.listProviders().search.map(provider => provider.id)).toEqual(['deepseek-search-api'])
    sent.length = 0
    for (const llmProvider of ['deepseek-official', 'openrouter']) await ctx.web.search({ query: 'mumbo', llmProvider })
    expect(sent.map(({ endpoint, authorization }) => ({ endpoint, authorization }))).toEqual([
      { endpoint: `${host}/v1/tools/search`, authorization: 'Bearer box-token' }, { endpoint: `${host}/v1/tools/search`, authorization: 'Bearer box-token' },
    ])
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
