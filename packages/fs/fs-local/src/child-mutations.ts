/**
 * Filesystem mutations performed by a helper process the subprocess provider starts as its
 * run-as identity, so the kernel checks every path component of a model-chosen path with that
 * identity's permissions instead of the harness's. One helper process serves one operation:
 * the request arrives on stdin as JSON and the outcome leaves on stdout as one JSON value.
 * @module dsh-fs-local/child-mutations
 */

import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PatchHunk } from '@deepseek-ai/dsh-fs-patch'
import { FS_ERROR_CODES, FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FileSystem,
  FsDeleteOutcome,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsMoveOutcome,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SubprocessCollectedOutputs, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** One mutation the helper performs with the local provider's own implementation. */
export type MutationRequest =
  | { op: 'write'; target: FsTarget; content: string; expected?: FsWriteIntent }
  | { op: 'edit'; target: FsTarget; edit: FsEditRequest; expected?: { version: FsVersion } }
  | { op: 'patch'; target: FsTarget; hunks: readonly PatchHunk[]; expected?: { version: FsVersion } }
  | { op: 'delete'; target: FsTarget; expected?: { version: FsVersion } }
  | {
    op: 'move'
    source: FsTarget
    destination: FsTarget
    options: { hunks?: readonly PatchHunk[]; expectedSource?: { version: FsVersion }; expectedDestination?: FsWriteIntent }
  }
  | { op: 'mkdir'; target: FsTarget }

/** What each request kind resolves to. */
export interface MutationOutcomes {
  write: FsWriteOutcome
  edit: FsEditOutcome
  patch: FsEditOutcome
  delete: FsDeleteOutcome
  move: FsMoveOutcome
  mkdir: null
}

/** The helper's stdin: one request plus the provider limit the helper applies. */
export type HelperInput = MutationRequest & { diffBasisMaxBytes: number }

/** The helper's stdout: the outcome or the failure it raised. */
export type HelperOutput =
  | { ok: true; value: unknown }
  | { ok: false; error: { message: string; code?: string } }

const HELPER_GRACE_MS = 2_000
const HELPER_STDERR_BYTES = 64 * 1024

/**
 * Perform one request through a provider running in the helper process.
 * @param fs - the helper's local provider, which mutates in-process.
 * @param request - the decoded request.
 * @returns the provider's outcome; `null` for directory creation.
 */
export async function performMutation(fs: FileSystem, request: MutationRequest): Promise<unknown> {
  switch (request.op) {
    case 'write': return fs.writeText(request.target, request.content, request.expected)
    case 'edit': return fs.editText(request.target, request.edit, request.expected)
    case 'patch': return fs.patchText(request.target, request.hunks, request.expected)
    case 'delete': return fs.deleteFile(request.target, request.expected)
    case 'move': return fs.moveFile(request.source, request.destination, request.options)
    case 'mkdir':
      await fs.makeDirectory(request.target)
      return null
  }
}

/**
 * Encode a failure for the parent: a filesystem error keeps its code, anything else only its message.
 * @param error - the value the operation threw.
 * @returns the helper's failure output.
 */
export function failureOutput(error: unknown): HelperOutput {
  if (error instanceof FsError) return { ok: false, error: { message: error.message, code: error.code } }
  return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'

function isWriteOutcome(value: unknown): value is FsWriteOutcome {
  return isRecord(value) && (value.operation === 'create' || value.operation === 'update')
    && isString(value.version) && isNullableString(value.before) && isString(value.after)
}

function isEditOutcome(value: unknown): value is FsEditOutcome {
  return isRecord(value) && isString(value.version) && isString(value.before) && isString(value.after)
}

function isMoveOutcome(value: unknown): value is FsMoveOutcome {
  if (!isRecord(value) || !isNullableString(value.sourceBefore) || !isWriteOutcome(value.destination)) return false
  if (value.sourceDeleted === true) return true
  const failure = value.sourceFailure
  return value.sourceDeleted === false && isRecord(failure) && isString(failure.message)
    && (FS_ERROR_CODES as readonly unknown[]).includes(failure.code)
}

const OUTCOME_CHECKS: { [K in MutationRequest['op']]: (value: unknown) => boolean } = {
  write: isWriteOutcome,
  edit: isEditOutcome,
  patch: isEditOutcome,
  delete: value => isRecord(value) && isNullableString(value.before),
  move: isMoveOutcome,
  mkdir: value => value === null,
}

/**
 * Strictly decode the helper's output. The helper runs as the run-as identity, so its output is
 * untrusted: a malformed or wrong-kind value is refused rather than reaching the caller.
 * @param op - the request kind the output must answer.
 * @param text - the helper's complete stdout.
 * @returns the validated outcome.
 * @throws {FsError} the helper's own filesystem failure, or `FS_IO_ERROR` for malformed output.
 */
export function decodeOutput<K extends MutationRequest['op']>(op: K, text: string): MutationOutcomes[K] {
  let output: unknown
  try {
    output = JSON.parse(text)
  } catch (_malformedJson) {
    // The outcome is unknown; the caller reports a failed change, never a guessed result.
    output = undefined
  }
  if (isRecord(output) && output.ok === false && isRecord(output.error) && isString(output.error.message)) {
    const code = output.error.code
    if ((FS_ERROR_CODES as readonly unknown[]).includes(code)) throw new FsError(output.error.message, code as FsErrorCode)
    throw new FsError(output.error.message, 'FS_IO_ERROR')
  }
  if (!isRecord(output) || output.ok !== true || !OUTCOME_CHECKS[op](output.value)) {
    throw new FsError('the file change helper returned a malformed result; the change may or may not have been applied', 'FS_IO_ERROR')
  }
  return brandVersions(output.value) as MutationOutcomes[K]
}

/** Re-brand the version strings an outcome carries. */
function brandVersions(value: unknown): unknown {
  if (!isRecord(value)) return value
  const copy: Record<string, unknown> = { ...value }
  if (isString(copy.version)) copy.version = FsVersion(copy.version)
  if (isRecord(copy.destination)) copy.destination = brandVersions(copy.destination)
  return copy
}

/**
 * The argv and environment that start the helper in the active runtime form.
 * @returns the helper invocation; source form loads it through tsx with the workspace path map.
 */
export function helperInvocation(): { argv: string[]; env: Record<string, string> } {
  /* v8 ignore next 3 -- built-artifact runs resolve the emitted helper; source-unit coverage cannot change import.meta.url. */
  if (extname(fileURLToPath(import.meta.url)) !== '.ts') {
    return { argv: [process.execPath, fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-fs-local/mutation-helper'))], env: {} }
  }
  return {
    argv: [process.execPath, '--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./mutation-helper.ts', import.meta.url))],
    env: { TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url)) },
  }
}

/**
 * Perform one mutation in a helper process started through the subprocess provider, which
 * applies its run-as identity. Cancellation is checked before the helper starts; a started
 * change runs to completion so a committed change is always reported.
 * @param subprocess - the provider that starts the helper as its run-as identity.
 * @param request - the mutation.
 * @param diffBasisMaxBytes - the provider limit the helper applies.
 * @param signal - checked before the helper starts.
 * @returns the validated outcome.
 * @throws {FsError} the change's own failure, or `FS_IO_ERROR` when the helper fails or misbehaves.
 */
export async function mutateInChild<K extends MutationRequest['op']>(
  subprocess: SubprocessRuntime,
  request: Extract<MutationRequest, { op: K }>,
  diffBasisMaxBytes: number,
  signal?: AbortSignal,
): Promise<MutationOutcomes[K]> {
  if (signal?.aborted) throw new FsError(`${request.op} aborted`, 'FS_ABORTED')
  const input: HelperInput = { ...request, diffBasisMaxBytes }
  const data = JSON.stringify(input)
  // The outcome echoes at most the request text and two bounded diff bases; JSON escaping can grow each sixfold.
  const maxBytes = 6 * (Buffer.byteLength(data) + 2 * diffBasisMaxBytes) + 64 * 1024
  const invocation = helperInvocation()
  const handle = subprocess.spawn({
    argv: invocation.argv,
    cwd: '/',
    env: invocation.env,
    stdio: { stdin: { data }, stdout: { maxBytes }, stderr: { maxBytes: HELPER_STDERR_BYTES } },
    graceMs: HELPER_GRACE_MS,
  })
  let outcome: Awaited<typeof handle.done>
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    // Spawn and provider failures reject with Error values.
    throw new FsError(`the file change helper could not run: ${(error as Error).message}`, 'FS_IO_ERROR', { cause: error })
  }
  // Collect-mode stdio always yields both readers.
  const collected = handle.collected as Required<SubprocessCollectedOutputs>
  const stdout = collected.stdout.readFrom(0)
  if (stdout.lossy) throw new FsError('the file change helper produced more output than its limit; the change may or may not have been applied', 'FS_IO_ERROR')
  if (stdout.text === '' && outcome.exitCode !== 0) {
    const stderr = collected.stderr.readFrom(0).text.trim()
    throw new FsError(`the file change helper failed (${outcome.signal ?? String(outcome.exitCode)}): ${stderr}`, 'FS_IO_ERROR')
  }
  return decodeOutput(request.op, stdout.text)
}
