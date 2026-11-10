/** Default deployment and machine fixtures for tests. */
import { join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => {
  const stateDir = overrides.stateDir ?? '/tmp/dsh-superagent-test'
  return {
    stateDir, workDirectory: join(stateDir, 'work'), promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
    admissionContextTimeoutMs: reference(15000), panelAdmins: [], ...overrides,
  }
}
export const testDeployment = (overrides: { [K in keyof Deployment]?: Deployment[K] | undefined } = {}): Deployment => ({
  ...testMachine(), repository: 'acme/widgets',
  github: { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' },
  feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
  // `feishu: undefined` removes the Feishu account; the type is widened for tests only.
  ...overrides as Partial<Deployment>,
})
