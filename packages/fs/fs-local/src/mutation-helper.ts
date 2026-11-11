/**
 * Entry of the file change helper: read one mutation request from stdin, perform it with an
 * in-process local provider under this process's own identity, and write one outcome to stdout.
 * The subprocess provider starts it as its run-as identity, so the kernel judges every path.
 * @module dsh-fs-local/mutation-helper
 */

import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from './index.ts'
import { failureOutput, performMutation } from './child-mutations.ts'
import type { HelperInput, HelperOutput } from './child-mutations.ts'

const OPS: ReadonlySet<unknown> = new Set(['write', 'edit', 'patch', 'delete', 'move', 'mkdir'])

/** Check the request kind and limit; the provider methods check the fields of each kind. */
function helperInput(value: unknown): HelperInput {
  const input = value as Partial<HelperInput> | null
  if (input === null || typeof input !== 'object' || !OPS.has(input.op)
    || !Number.isSafeInteger(input.diffBasisMaxBytes) || (input.diffBasisMaxBytes as number) <= 0) {
    throw new Error('the file change helper received a malformed request')
  }
  return input as HelperInput
}

/**
 * Perform one encoded request with a fresh in-process provider.
 * @param text - the complete stdin: a JSON {@link HelperInput}.
 * @returns the JSON {@link HelperOutput} to write to stdout.
 */
export async function runMutationHelper(text: string): Promise<string> {
  let output: HelperOutput
  const ctx = new Context()
  try {
    const { diffBasisMaxBytes, ...request } = helperInput(JSON.parse(text))
    // No subprocess service is mounted here, so the provider mutates in this process.
    await ctx.plugin(LocalFileSystem, { cwd: '/', diffBasisMaxBytes })
    output = { ok: true, value: await performMutation(ctx.fs, request) }
  } catch (error: unknown) {
    output = failureOutput(error)
  } finally {
    await ctx.fiber.dispose()
  }
  return JSON.stringify(output)
}

/* v8 ignore start -- runs only as the helper process, whose behavior the provider tests observe through its output. */
if (import.meta.main) {
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => { chunks.push(chunk) })
  process.stdin.on('end', () => {
    void runMutationHelper(Buffer.concat(chunks).toString('utf8')).then((output) => { process.stdout.write(output) })
  })
}
/* v8 ignore stop */
