/** Main plugin entry: mounts the Runtime and the relay Source, and provides the Runtime's restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'
import { registerRelay } from './sources/relay.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'connection', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  // Under a run-as provider the worker directory and the orchestrator's gh configuration must be root's; fail loud at load.
  const machine = machineOf(config, ctx.subprocess.childIdentity !== undefined)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  // The relay Source belongs to this entry rather than a plugin row of its own, so a profile that loads the bundle has it.
  ctx.effect(() => registerRelay(ctx, runtime), 'dsh-superagent: relay Source')
  // Not awaited (`UPSTREAM.md` S15): the main Session's ensure resolves an Agent preset, and the preset registry waits for the
  // Loader to settle while a preset row waits for a service, which would wait for this start.
  runtime.ready.then(() => {
    if (runtime.lifetime.aborted) return
    ctx.logger.info(runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
  }, (error: unknown) => {
    if (!runtime.lifetime.aborted) ctx.logger.error('dsh-superagent could not start: %s', String(error))
  })
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
