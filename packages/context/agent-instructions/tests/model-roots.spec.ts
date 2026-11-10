/** Instruction discovery beside a link the model planted out of its directories. */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import * as AgentInstructions from '../src/index.ts'
import { findProjectRoot } from '../src/files.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let base: string | undefined
afterEach(async () => {
  if (base !== undefined) await rm(base, { recursive: true, force: true })
  base = undefined
})

describe.runIf(process.platform === 'linux')('project root discovery under model roots', () => {
  it('treats a planted marker link out of the roots as absent instead of failing the lookup', async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-instructions-roots-')))
    const workspace = join(base, 'projects')
    await mkdir(join(workspace, 'app', 'src'), { recursive: true })
    await mkdir(join(base, 'secret'))
    await mkdir(join(workspace, '.git'))
    await symlink(join(base, 'secret'), join(workspace, 'app', '.git'))
    const ctx = new Context()
    try {
      await ctx.plugin(LocalFileSystem, { modelRoots: [workspace] })
      await expect(findProjectRoot(join(workspace, 'app', 'src'), ['.git'], ctx.fs)).resolves.toBe(workspace)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never loads instructions from a recorded directory outside the roots, such as a planted AGENTS.md link', async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-instructions-roots-')))
    const projects = join(base, 'projects')
    const outside = join(base, 'tmp', 'x')
    await mkdir(projects, { recursive: true })
    await mkdir(outside, { recursive: true })
    await mkdir(join(base, 'home'))
    await writeFile(join(base, 'member.key'), 'TOPSECRET-MEMBER-KEY\n')
    await writeFile(join(projects, 'AGENTS.md'), 'project rule\n')
    // The model's shell plants the link in a directory it owns outside the roots.
    await symlink(join(base, 'member.key'), join(outside, 'AGENTS.md'))
    vi.stubEnv('DSH_HOME', join(base, 'home'))
    vi.stubEnv('DSH_AGENTS_HOME', join(base, 'home'))
    const ctx = new Context()
    try {
      const adapter = new MockAdapter([textResponse('done')])
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LocalFileSystem, { cwd: projects, modelRoots: [projects] })
      await ctx.plugin(WorkingDirectory, {})
      await ctx.plugin(AgentInstructions, { maxBytes: 65536 })
      await ctx.plugin(AgentLoop, { agents: [] })
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = await ctx.agentLoop.create(SessionId('planted-instructions'), { provider: 'mock', model: 'mock' }, { cwd: projects })
      // A directory recorded before the roots applied, or chosen by the person, lies outside them.
      await ctx.workingDirectory.set(agent, outside)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      const request = JSON.stringify(adapter.requests.at(-1))
      expect(request).not.toContain('TOPSECRET-MEMBER-KEY')
      expect(request).toContain('project rule')
      expect(ctx.workingDirectory.get(agent.session)).toBe(projects)
    } finally {
      vi.unstubAllEnvs()
      await ctx.fiber.dispose()
    }
  })
})
