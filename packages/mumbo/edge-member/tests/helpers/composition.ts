/**
 * Shared pieces of the member composition specs: a Loader that boots a test-only cordis.yml from an import map, the
 * stand-in Session methods a member calls, and an HTTP call carrying the member header.
 */

import type { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { Remote, TypertRemoteService, principalOf, type Principal } from '@deepseek-ai/dsh-typert-protocol'
import { pathToFileURL } from 'node:url'

/** Stands in for the Session Controller's methods: records the caller the Gateway admitted. */
export class PromptProbe extends TypertRemoteService {
  readonly callers: (Principal | undefined)[] = []
  constructor(ctx: Context) {
    super(ctx, 'promptProbe', { namespace: 'session' })
  }

  @Remote('prompt')
  prompt(request: { readonly sessionId: string; readonly text: string }): string {
    void request
    this.callers.push(principalOf(this.ctx.invocation))
    return 'queued'
  }

  @Remote('page')
  page(request: { readonly sessionId: string }): string {
    this.callers.push(principalOf(this.ctx.invocation))
    return `page of ${request.sessionId}`
  }

  @Remote('create')
  create(request: { readonly workspaceId?: string; readonly cwd?: string; readonly sessionId?: string }): string {
    this.callers.push(principalOf(this.ctx.invocation))
    return request.sessionId ?? 'new'
  }

  @Remote('updateQueue')
  updateQueue(request: { readonly sessionId: string }): string {
    void request
    this.callers.push(principalOf(this.ctx.invocation))
    return 'edited'
  }
}

/**
 * Start a real Loader over one cordis.yml whose plugin names resolve only from `modules`.
 * @param ctx - root Context already holding the services the fixture's rows inject but do not load.
 * @param config - absolute path of the cordis.yml fixture.
 * @param modules - the module each plugin name in the fixture loads.
 * @returns the Loader, and the promise that settles with `loader.await()` once every row has loaded or failed.
 */
export async function startLoader(
  ctx: Context,
  config: string,
  modules: ReadonlyMap<string, object>,
): Promise<{ readonly loader: Context['loader']; readonly settled: Promise<void> }> {
  await ctx.plugin(Loader)
  const loader = ctx.loader
  loader.builtins.group = Group
  loader.builtins.include = class FixtureInclude extends Include {
    override import(specifier: string, getOuterStack?: () => string[]): unknown {
      if (specifier.startsWith('cordis:')) return super.import(specifier, getOuterStack)
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    }
  }
  const settled = loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } }).then(() => loader.await())
  return { loader, settled }
}

/**
 * Provide the in-memory credential records Connection keeps the owner's cookie signing record in.
 * @param ctx - root Context the fixture's Connection row injects `credentials` from.
 */
export function provideCredentials(ctx: Context): void {
  const records = new Map<unknown, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next ?? records.get(key)
    },
  } as never)
}

/**
 * POST one Remote call to the Web carrier, as the member a header names when one is given.
 * @param origin - the Web carrier's origin.
 * @param method - the `namespace/method` endpoint.
 * @param args - the call's named arguments.
 * @param header - the signed member header, or undefined to send none.
 * @param extra - further request headers.
 * @returns the HTTP status and the JSON body of a success, or the text of a refusal.
 */
export async function call(
  origin: string,
  method: string,
  args: Record<string, unknown>,
  header?: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra, ...header === undefined ? {} : { 'x-mumbo-member': header } },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload: { args } }),
  })
  return { status: response.status, body: response.ok ? await response.json() : await response.text() }
}

/** @returns the current Unix time in whole seconds, as the member header counts it. */
export const now = (): number => Math.floor(Date.now() / 1000)
