/**
 * Provider-wide run-as identity: its validated configuration, the explicit environment every
 * child receives under it, and the secret-name guard applied to that final environment.
 * @module dsh-subprocess-local/run-as
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
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

/** Name of one further run-as identity that a caller's config selects for a spawn. */
export const IDENTITY_NAME = /^[a-z][a-z0-9-]{0,31}$/u

/**
 * The credentials of one configured identity alone, as the exec bootstrap receives them.
 * @param runAs - the configured identity and environment.
 * @returns its user id, group id, and supplementary groups.
 */
export function credentialsOf(runAs: RunAs): RunAsIdentity {
  return { uid: runAs.uid, gid: runAs.gid, groups: runAs.groups }
}

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
 * @param field - the config field named in a refusal, such as `runAs` or `identities.desktop`.
 * @throws when any field is unusable; the message names the field.
 */
export function validateRunAs(runAs: RunAs, platform: NodeJS.Platform, field = 'runAs'): void {
  const fail = (detail: string): never => { throw new Error(`subprocess-local: ${field} ${detail}`) }
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

/** Reads one path's owner and mode; `statSync` outside tests. */
export type StatPath = (path: string) => { uid: number; gid: number; mode: number }

/** The real path of `directory` and each of its ancestors, the filesystem root first. */
function ancestry(directory: string): string[] {
  const chain: string[] = []
  for (let path = realpathSync.native(directory); ; path = dirname(path)) {
    chain.unshift(path)
    if (dirname(path) === path) return chain
  }
}

/**
 * Require a directory that no user other than its owner and root can write, directly or by replacing it through an
 * ancestor: the directory is owned by `uid` and not writable by group or others, and every ancestor is owned by root
 * or `uid` and not writable by group or others, except a sticky ancestor whose next entry `uid` owns.
 * @param directory - the directory to check.
 * @param refusal - the error message when the check fails.
 * @param statPath - reads each path's owner and mode.
 * @param uid - the required owner; this process's user by default.
 * @returns the directory's real path.
 * @throws when the directory or an ancestor fails the check.
 */
export function assertPrivateDirectory(
  directory: string, refusal: string, statPath: StatPath = statSync, uid = process.getuid?.(),
): string {
  const chain = ancestry(directory)
  chain.forEach((path, index) => {
    const info = statPath(path)
    const shared = (info.mode & 0o022) !== 0
    const next = chain[index + 1]
    const safe = next === undefined
      ? info.uid === uid && !shared
      : (info.uid === 0 || info.uid === uid) && (!shared || ((info.mode & 0o1000) !== 0 && statPath(next).uid === uid))
    if (!safe) throw new Error(refusal)
  })
  return chain[chain.length - 1] as string
}

/**
 * Require that only root can change what an absolute path names: every directory on its spelling, which holds a name
 * the lookup passes, and every directory on its real path is owned by root and writable by no group or other user, so
 * no other user can add an entry, replace one, or repoint a link on the way.
 * @param path - the path to check.
 * @param refusal - the error message when the check fails.
 * @param statPath - reads each path's owner and mode, following links.
 * @throws when the path is relative or missing, or any of those directories fails the check.
 */
export function assertRootOwnedPath(path: string, refusal: string, statPath: StatPath = statSync): void {
  if (!isAbsolute(path)) throw new Error(refusal)
  let real: string
  try {
    real = realpathSync.native(path)
  } catch (_missing) {
    // A path that does not resolve names nothing root controls.
    throw new Error(refusal)
  }
  const prefixes = (spelling: string): string[] => spelling === dirname(spelling) ? [spelling] : [...prefixes(dirname(spelling)), spelling]
  for (const directory of new Set([...prefixes(resolve(path)), ...prefixes(real)])) {
    const info = statPath(directory)
    if (info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error(refusal)
  }
}

/** An identity that runs servers: its name and its home's real path. */
export interface ServerIdentity {
  /** The `identities` entry that runs servers. */
  name: string
  /** The real path of the identity's `set.HOME`. */
  home: string
}

/**
 * Check an `identities` entry that runs servers, such as the servers a person configures, failing loudly otherwise: its
 * `set` names `HOME` by its real path, a directory owned by the identity that no other user but root can write,
 * directly or through an ancestor, and that the identity can search, and `PATH`, which callers cannot replace; every
 * `PATH` and `NODE_PATH` entry it receives passes {@link assertRootOwnedPath}.
 * @param name - the configured `serverIdentity`, or another identity a server starts as.
 * @param identities - the provider's further identities.
 * @param statPath - reads each path's owner and mode.
 * @returns the identity's name and home.
 * @throws when the name is not listed or any of these conditions fails; the message names the field.
 */
export function resolveServerIdentity(name: string, identities: ReadonlyMap<string, RunAs>, statPath: StatPath = statSync): ServerIdentity {
  const runAs = identities.get(name)
  if (runAs === undefined) throw new Error(`subprocess-local: serverIdentity ${JSON.stringify(name)} must name an entry of identities`)
  const field = `identities.${name}`
  const home = runAs.set.HOME
  if (home === undefined || !isAbsolute(home)) throw new Error(`subprocess-local: ${field}.set.HOME must name the server identity's home, an absolute directory`)
  let real: string
  try {
    real = realpathSync.native(home)
  } catch (_missing) {
    // Reported below with the rule the home must meet.
    real = ''
  }
  if (real !== home) throw new Error(`subprocess-local: ${field}.set.HOME ${JSON.stringify(home)} must be an existing directory named by its real path`)
  assertPrivateDirectory(home, `subprocess-local: ${field}.set.HOME ${JSON.stringify(home)} must be owned by uid ${String(runAs.uid)} and writable by no other user but root, directly or through an ancestor`, statPath, runAs.uid)
  assertSearchable(home, credentialsOf(runAs), path => `subprocess-local: ${field} (uid ${String(runAs.uid)}) cannot search ${JSON.stringify(path)}, so its servers cannot start in its home`, statPath)
  if (runAs.set.PATH === undefined) throw new Error(`subprocess-local: ${field}.set.PATH must be set, so no caller replaces the server identity's PATH`)
  assertServerSearchPaths(runAsEnvironment(runAs), field)
  return { name, home }
}

/**
 * Refuse a server identity's environment whose `PATH` or `NODE_PATH` names a directory a user other than root could
 * change, where planted code would run with the person's server credentials.
 * @param env - the environment the server receives.
 * @param field - the config field named in a refusal.
 * @param statPath - reads each path's owner and mode.
 * @throws when an entry fails {@link assertRootOwnedPath}.
 */
export function assertServerSearchPaths(env: Readonly<NodeJS.ProcessEnv>, field: string, statPath: StatPath = statSync): void {
  for (const variable of ['PATH', 'NODE_PATH']) {
    for (const entry of env[variable]?.split(delimiter) ?? []) {
      assertRootOwnedPath(entry, `subprocess-local: ${field} ${variable} entry ${JSON.stringify(entry)} must be an absolute existing directory that only root can change: every directory on its path owned by root and writable by no group or other user`, statPath)
    }
  }
}

/**
 * Require that an identity can search a directory and every ancestor, by the owner, group, or other search bit that
 * applies to it.
 * @param directory - the directory to check.
 * @param identity - the identity that must enter the directory.
 * @param refusal - builds the error message from the first path it cannot search.
 * @param statPath - reads each path's owner and mode.
 * @throws when the identity cannot search the directory or an ancestor.
 */
export function assertSearchable(
  directory: string, identity: RunAsIdentity, refusal: (path: string) => string, statPath: StatPath = statSync,
): void {
  for (const path of ancestry(directory)) {
    const info = statPath(path)
    const bit = info.uid === identity.uid ? 0o100 : info.gid === identity.gid || identity.groups.includes(info.gid) ? 0o010 : 0o001
    if ((info.mode & bit) === 0) throw new Error(refusal(path))
  }
}

/**
 * Require host facts run-as depends on, failing loudly otherwise:
 * - this process's temporary directory, where the root bootstrap's launch requests and its module cache live, is
 *   named by its real path, since every later use joins onto that spelling, and is writable by no other user,
 *   directly or through an ancestor (see {@link assertPrivateDirectory});
 * - `fs.protected_hardlinks` is 1, so the run-as user cannot hard-link files it may not access
 *   into a directory the model may read.
 * @param temporaryDirectory - this process's `os.tmpdir()`.
 * @param readSysctl - reads a `/proc/sys` file.
 * @param statPath - reads each path's owner and mode.
 * @throws when either fact does not hold; the message names the fix.
 */
export function assertRunAsHost(
  temporaryDirectory: string,
  readSysctl: (path: string) => string = path => readFileSync(path, 'utf8'),
  statPath: StatPath = statSync,
): void {
  const real = realpathSync.native(temporaryDirectory)
  if (real !== temporaryDirectory) {
    throw new Error(`subprocess-local: runAs requires TMPDIR to name its real path, but ${JSON.stringify(temporaryDirectory)} resolves to ${JSON.stringify(real)}; start dsh with TMPDIR=${real}`)
  }
  assertPrivateDirectory(temporaryDirectory, `subprocess-local: runAs requires a temporary directory no other user can write, but ${JSON.stringify(real)} is not; start dsh with TMPDIR set to a root-only directory such as /root/.dsh/tmp`, statPath)
  if (readSysctl(join('/proc/sys/fs', 'protected_hardlinks')).trim() !== '1') {
    throw new Error('subprocess-local: runAs requires fs.protected_hardlinks=1, so the run-as user cannot hard-link files it may not read; set it with sysctl before starting dsh')
  }
}
