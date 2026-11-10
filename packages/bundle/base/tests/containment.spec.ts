/**
 * Agent containment through a real `cordis.yml` Loader composition of the base rows a contained
 * box runs: `subprocess-local` with `runAs`, the sandboxed filesystem with `modelRoots`, and the
 * model's bash and file tools under Full access. The tests are not root, so the run-as identity is
 * this process's own; the provider's own suite proves a different identity is refused.
 */
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SandboxedBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** This process's supplementary groups, the only set a non-root test can keep. */
function supplementaryGroups(): number[] {
  const line = readFileSync('/proc/self/status', 'utf8').split('\n').find(entry => entry.startsWith('Groups:')) as string
  return line.slice('Groups:'.length).trim().split(/\s+/u).filter(id => id !== '').map(Number)
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function agent(ctx: Context, cwd: string): Promise<Agent> {
  const id = SessionId('containment-agent')
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false })
  const value: Agent = {
    id, options: {}, session, model: unsupportedModel(), inbox: unsupportedInbox(), status: 'idle', ctx: scope.ctx,
    send: () => {}, followup: () => {}, steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {}, cancel() {}, runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

const suite = process.platform === 'linux' ? describe : describe.skip

suite('agent containment through a real cordis.yml composition', () => {
  it('runs the model shell as the run-as identity with its explicit environment and confines the file tools', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-containment-')))
    const projects = join(root, 'projects')
    const home = join(root, 'agent-home')
    const secret = join(root, 'secret')
    for (const directory of [projects, home, secret]) await mkdir(directory)
    await writeFile(join(secret, 'key'), 'box-secret')
    await writeFile(join(projects, 'notes.txt'), 'project notes')
    vi.stubEnv('DEEPSEEK_API_KEY', 'box-token')
    vi.stubEnv('MUMBO_MEMBER_KEY', 'member-key')
    vi.stubEnv('CONTAINMENT_AMBIENT', 'not-inherited')

    const uid = process.getuid!()
    const gid = process.getgid!()
    const groups = supplementaryGroups()
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-tool-executor-native'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(projects)}`,
      "- name: '@deepseek-ai/dsh-sandbox-local'",
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      '  config:',
      '    runAs:',
      `      uid: ${uid}`,
      `      gid: ${gid}`,
      `      groups: ${JSON.stringify(groups)}`,
      '      inherit: [PATH, LANG]',
      '      set:',
      `        HOME: ${JSON.stringify(home)}`,
      '        USER: agent',
      '      secretNames: [DEEPSEEK_API_KEY, MUMBO_MEMBER_KEY]',
      "- name: '@deepseek-ai/dsh-fs-sandbox'",
      '  config:',
      `    cwd: ${JSON.stringify(projects)}`,
      `    modelRoots: ${JSON.stringify([projects, home])}`,
      "- name: '@deepseek-ai/dsh-working-directory'",
      '  config:',
      `    defaultDirectory: ${JSON.stringify(projects)}`,
      "- name: '@deepseek-ai/dsh-bash-sandbox'",
      "- name: '@deepseek-ai/dsh-shell-env'",
      "- name: '@deepseek-ai/dsh-tool-bash'",
      "- name: '@deepseek-ai/dsh-tool-fs'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@deepseek-ai/dsh-sandbox-local', LocalSandbox],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
      ['@deepseek-ai/dsh-fs-sandbox', SandboxedFileSystem],
      ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
      ['@deepseek-ai/dsh-bash-sandbox', SandboxedBashExecutor],
      ['@deepseek-ai/dsh-shell-env', ShellEnv],
      ['@deepseek-ai/dsh-tool-bash', ToolBash],
      ['@deepseek-ai/dsh-tool-fs', ToolFs],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as never
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const owner = await agent(context, projects)
    let callNumber = 0
    const execute = (name: string, args: unknown) => executeToolFixture(context!, {
      signal: new AbortController().signal, callId: ToolCallId(`containment-${++callNumber}`), name, arguments: args, agent: owner,
    })

    const shell = text(await execute('bash', {
      command: 'printf "uid=%s gid=%s groups=%s\\n" "$(id -u)" "$(id -g)" "$(id -G | tr " " "\\n" | sort -n | tr "\\n" " ")"; env | sort',
      description: 'Show identity and environment',
    }))
    expect(shell).toContain(`uid=${uid} gid=${gid} groups=${[...new Set([gid, ...groups])].sort((a, b) => a - b).join(' ')} `)
    expect(shell).toContain(`HOME=${home}\n`)
    expect(shell).toContain('USER=agent\n')
    expect(shell).not.toContain('DEEPSEEK_API_KEY')
    expect(shell).not.toContain('MUMBO_MEMBER_KEY')
    expect(shell).not.toContain('CONTAINMENT_AMBIENT')
    expect(shell).not.toContain('box-token')

    const refusal = (path: string): string =>
      `Error: cannot access "${path}": its real path is outside the directories you can access (${projects}, ${home})`
    expect(text(await execute('read', { file_path: 'notes.txt' }))).toContain('project notes')
    expect(text(await execute('read', { file_path: '/proc/self/environ' }))).toBe(refusal('/proc/self/environ'))
    expect(text(await execute('read', { file_path: join(secret, 'key') }))).toBe(refusal(join(secret, 'key')))

    // The shell can plant a link to the secret; the file tools refuse to follow it.
    await execute('bash', { command: `ln -s ${JSON.stringify(secret)} escape`, description: 'Plant a link' })
    expect(text(await execute('read', { file_path: 'escape/key' }))).toBe(refusal(join(projects, 'escape/key')))
    expect(text(await execute('write', { file_path: 'escape/key', content: 'overwritten' }))).toBe(refusal(join(projects, 'escape/key')))
    expect(await readFile(join(secret, 'key'), 'utf8')).toBe('box-secret')
  })
})
