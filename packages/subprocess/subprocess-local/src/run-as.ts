/**
 * Provider-wide run-as identity: its validated configuration, the explicit environment every
 * child receives under it, and the secret-name guard applied to that final environment.
 * @module dsh-subprocess-local/run-as
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { scrubbedParentEnv, SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'

/** The credentials the Linux bootstrap applies before it enters the target program. */
export interface RunAsIdentity {
  /** Real, effective, saved, and filesystem user id. */
  uid: number
  /** Real, effective, saved, and filesystem group id. */
  gid: number
  /** The complete supplementary group list; empty means none. */
  groups: number[]
}

/** Run every child of this provider as one fixed non-root identity with an explicit environment. */
export interface RunAs extends RunAsIdentity {
  /** Names a child inherits from this process's credential-scrubbed environment; every other ambient name is dropped. */
  inherit: string[]
  /** Fixed values every child receives; they replace inherited and caller-supplied entries of the same name. */
  set: Record<string, string>
  /** Names that must never reach a child; a launch whose final environment contains one fails before it starts. */
  secretNames: string[]
}

/** Validated `runAs` row of the provider config. */
export const RunAs: z<RunAs> = z.object({
  uid: z.natural().required(),
  gid: z.natural().required(),
  groups: z.array(z.natural()).required(),
  inherit: z.array(String).required(),
  set: z.dict(String).required(),
  secretNames: z.array(String).required(),
})

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** A launch refused because its final environment names a configured secret. */
export class SubprocessSecretEnvironmentError extends Error {
  override readonly name = 'SubprocessSecretEnvironmentError'

  /** @param names - the offending environment names; values are never included. */
  constructor(readonly names: readonly string[]) {
    super(`subprocess-local: refusing to start a process whose environment contains ${names.join(', ')}; a run-as child must never receive these names`)
  }
}

/**
 * Reject a run-as configuration that cannot hold its promise: a non-Linux host, a root identity,
 * an invalid or credential-shaped name, or an inherited or fixed name listed as a secret.
 * @param runAs - the configured identity and environment.
 * @param platform - the host platform.
 * @throws when any field is unusable; the message names the field.
 */
export function validateRunAs(runAs: RunAs, platform: NodeJS.Platform): void {
  const fail = (detail: string): never => { throw new Error(`subprocess-local: runAs ${detail}`) }
  if (platform !== 'linux') fail(`requires Linux; this host is ${platform}`)
  for (const [field, id] of [['uid', runAs.uid], ['gid', runAs.gid], ...runAs.groups.map(id => ['groups', id] as const)] as const) {
    if (!Number.isSafeInteger(id) || id <= 0) fail(`.${field} must be a positive integer, not ${String(id)}; 0 is root`)
  }
  if (runAs.secretNames.length === 0) fail('.secretNames must name at least one variable')
  for (const name of [...runAs.inherit, ...Object.keys(runAs.set), ...runAs.secretNames]) {
    if (!ENVIRONMENT_NAME.test(name)) fail(`names an invalid environment variable ${JSON.stringify(name)}`)
  }
  for (const name of runAs.inherit) {
    // scrubbedParentEnv never carries these names, so inheriting one would silently do nothing.
    if (SENSITIVE_ENV_PATTERN.test(name)) fail(`.inherit names credential-shaped ${name}, which is never inherited; supply it through .set if the child needs it`)
  }
  for (const value of Object.values(runAs.set)) {
    if (value.includes('\0')) fail('.set values must not contain NUL')
  }
  const secrets = new Set(runAs.secretNames.map(name => name.toUpperCase()))
  for (const name of [...runAs.inherit, ...Object.keys(runAs.set)]) {
    if (secrets.has(name.toUpperCase())) fail(`passes ${name}, which .secretNames lists`)
  }
}

/**
 * Build a run-as child's environment: only the inherited names of the scrubbed parent
 * environment, then the caller's explicit entries (`undefined` removes one), then the fixed values.
 * @param runAs - the configured identity and environment.
 * @param explicit - the spawn request's explicit entries.
 * @returns the environment before launch-specific additions and the secret guard.
 */
export function runAsEnvironment(runAs: RunAs, explicit?: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const ambient = scrubbedParentEnv()
  const env: NodeJS.ProcessEnv = {}
  for (const name of runAs.inherit) {
    if (ambient[name] !== undefined) env[name] = ambient[name]
  }
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (value === undefined) Reflect.deleteProperty(env, name)
    else env[name] = value
  }
  return { ...env, ...runAs.set }
}

/**
 * Refuse a final child environment that names a configured secret, compared case-insensitively.
 * @param runAs - the configured identity and its secret names.
 * @param env - the complete environment the child would receive.
 * @throws {SubprocessSecretEnvironmentError} when any secret name is present.
 */
export function assertNoSecretNames(runAs: RunAs, env: Readonly<Record<string, string>>): void {
  const secrets = new Set(runAs.secretNames.map(name => name.toUpperCase()))
  const found = Object.keys(env).filter(name => secrets.has(name.toUpperCase()))
  if (found.length > 0) throw new SubprocessSecretEnvironmentError(found)
}

/**
 * Require host facts run-as depends on, failing loudly otherwise:
 * - this process's temporary directory, where the root bootstrap's launch requests and its
 *   module cache live, is writable by no other user: it and each ancestor are owned by this
 *   process or not writable by group or others, a sticky ancestor counting only when this process
 *   owns the entry below it;
 * - `fs.protected_hardlinks` is 1, so the run-as user cannot hard-link files it may not access
 *   into a directory the model may read.
 * @param temporaryDirectory - this process's `os.tmpdir()`.
 * @param readSysctl - reads a `/proc/sys` file.
 * @throws when either fact does not hold; the message names the fix.
 */
export function assertRunAsHost(
  temporaryDirectory: string,
  readSysctl: (path: string) => string = path => readFileSync(path, 'utf8'),
): void {
  const uid = process.getuid?.()
  const real = realpathSync.native(temporaryDirectory)
  const chain: string[] = []
  for (let path = real; ; path = dirname(path)) {
    chain.unshift(path)
    if (dirname(path) === path) break
  }
  chain.forEach((path, index) => {
    const info = statSync(path)
    const shared = (info.mode & 0o022) !== 0
    const next = chain[index + 1]
    const own = next === undefined ? info.uid === uid : (info.mode & 0o1000) !== 0 && statSync(next).uid === uid
    if (next === undefined ? !own || shared : shared && !own) {
      throw new Error(`subprocess-local: runAs requires a temporary directory no other user can write, but ${JSON.stringify(real)} is not; start dsh with TMPDIR set to a root-only directory such as /root/.dsh/tmp`)
    }
  })
  if (readSysctl(join('/proc/sys/fs', 'protected_hardlinks')).trim() !== '1') {
    throw new Error('subprocess-local: runAs requires fs.protected_hardlinks=1, so the run-as user cannot hard-link files it may not read; set it with sysctl before starting dsh')
  }
}
