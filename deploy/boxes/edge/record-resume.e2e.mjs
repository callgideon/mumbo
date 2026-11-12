// Records the E2B API's raw answers to a resume, and to the create that finds the cell full, from throwaway sandboxes this
// script creates itself, as redacted fixtures in testing/fixtures/resume/ for the edge's classification tests. Run it only
// as RUNBOOK.md "Recording E2B answers" says: in ap-south-1, before R8, with the founder's go-ahead and the temporary
// client-proxy rule. Env: E2B_API_URL, E2B_SANDBOX_URL, E2B_API_KEY (the cell's TEAM_API_KEY) and CELL.
// Usage: node deploy/boxes/edge/record-resume.e2e.mjs guest-unresponsive --go-ahead <YYYY-MM-DD>
//        ... full-cell prepare|fill|resume --go-ahead <YYYY-MM-DD> [--lose <email>]...
//        ... cleanup
// Before it connects to, pauses, resumes or kills a sandbox, it checks that E2B lists that sandbox with this run's nonce,
// which only this script's creates carry and record-resume.local.json keeps until cleanup. It prints statuses, error
// codes, class names and durations, never a key, a token or an id.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { ApiClient, ConnectionConfig, Sandbox } from 'e2b'
import { describeError, sdkError } from './testing/e2b-answers.mjs'

/** The metadata `purpose` of every throwaway; no edge adopts, backs up or pauses a sandbox without `metadata.user`. */
export const PURPOSE = 'b47b-recording'
const RECORDING_CELL = 'ap-south-1'
const USAGE = 'usage: record-resume.e2e.mjs guest-unresponsive | full-cell prepare|fill|resume [--lose <email>]... (both with --go-ahead <YYYY-MM-DD>) | cleanup'
const STATE = new URL('./record-resume.local.json', import.meta.url)
const FIXTURES = new URL('./testing/fixtures/resume/', import.meta.url)
const TTL_S = 1200  // E2B kills a throwaway 20 minutes after its create or last connect, so a crashed run leaves only paused ones
const MAX_CREATES = 30  // the fill's bound: the node's 48 GiB pool holds about 6 project fillers before the children
const CREATE = '/v2/sandboxes', PAUSE = '/sandboxes/{sandboxID}/pause', CONNECT = '/v2/sandboxes/{sandboxID}/connect'
// Faults about 85% of the guest's memory into a tmpfs capped at 90%, so the node's hugepages back it.
const TOUCH = 'mkdir -p /run/fill && mount -t tmpfs -o size=90% fill /run/fill && dd if=/dev/zero of=/run/fill/x bs=1M status=none ' +
  "count=$(awk '/^MemTotal/ { print int($2 * 0.85 / 1024) }' /proc/meminfo)"

/**
 * Parses argv (after the script name) and the environment. Throws unless the command is known and every variable is set;
 * a recording also needs CELL ap-south-1 and the date of the founder's go-ahead.
 * @returns {{ cmd: string, step?: string, cell: string, lose: string[] }} `lose`: lowercased emails whose sandboxes the
 *   founder agreed the fill may crash
 */
export function recorderArgs(argv, env) {
  const [cmd, step] = argv
  if (!(['guest-unresponsive', 'cleanup'].includes(cmd) || (cmd === 'full-cell' && ['prepare', 'fill', 'resume'].includes(step)))) throw new Error(USAGE)
  for (const name of ['E2B_API_URL', 'E2B_SANDBOX_URL', 'E2B_API_KEY', 'CELL']) if (!env[name]) throw new Error(`set ${name}`)
  const values = (flag) => argv.flatMap((a, i) => a === flag ? [argv[i + 1]] : [])
  if (cmd !== 'cleanup') {
    if (env.CELL !== RECORDING_CELL) throw new Error(`recordings run in ${RECORDING_CELL} only (CELL), before R8`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values('--go-ahead')[0] ?? '')) throw new Error('--go-ahead <YYYY-MM-DD>: the date of the founder\'s go-ahead for the client-proxy rule and the fill')
  }
  return { cmd, ...(cmd === 'full-cell' && { step }), cell: env.CELL, lose: values('--lose').map(e => String(e).toLowerCase()) }
}

/** Refuses unless E2B lists `id` with this run's metadata, so a call reaches only a throwaway this run created. */
export async function assertMine(E2BSandbox, run, id) {
  const { metadata } = await E2BSandbox.getInfo(id)
  if (metadata?.purpose !== PURPOSE || metadata.run !== run) throw new Error('refusing: that sandbox is not a throwaway of this run')
}

/** Every sandbox `E2BSandbox` lists for `query`, across pages. */
async function listAll(E2BSandbox, query) {
  const pager = E2BSandbox.list({ query: { state: ['running', 'paused'], ...query } })
  const out = []
  while (pager.hasNext) out.push(...await pager.nextItems())
  return out
}

/**
 * Refuses unless every running or paused sandbox in the cell is a recording throwaway or belongs to an email in `lose`.
 * The refusal names each other owner's email, or "a project box" or "a sandbox without an owner", never an id.
 */
export async function assertOnlyThrowaways(E2BSandbox, lose) {
  const others = new Set()
  for (const { metadata: m = {} } of await listAll(E2BSandbox, {})) {
    const who = String(m.owner ?? m.user ?? '').toLowerCase()
    if (m.purpose === PURPOSE || (who.includes('@') && lose.includes(who))) continue
    others.add(who.startsWith('project:') ? 'a project box' : who.includes('@') ? who : 'a sandbox without an owner')
  }
  if (others.size) throw new Error(`refusing: the cell also holds ${[...others].join(', ')}; the fill could crash them (RUNBOOK "Recording E2B answers")`)
}

const KEPT_HEADERS = ['content-type', 'should-retry', 'retry-after']
/**
 * What a fixture keeps of an API answer: three headers, the error body, and a 2xx body only as its `state`, since it carries
 * the box's access tokens.
 * @param {{ status: number, headers: Headers, body?: any }} answer
 */
export function keptResponse({ status, headers, body }) {
  const kept = Object.fromEntries(KEPT_HEADERS.flatMap(h => headers.get(h) === null ? [] : [[h, headers.get(h)]]))
  const b = status < 300 ? body?.state && { state: body.state } : body
  return { status, headers: kept, ...(b && { body: b }) }
}

/** `text` with each throwaway id, alone or in E2B's `<id>-<client>` form, replaced by <sandbox>, <sandbox-2>, … in creation order. */
export const redactIds = (text, ids) => ids.reduce((t, id, i) => t.replace(new RegExp(`${id}(?:-[0-9a-z]+)?`, 'g'), i ? `<sandbox-${i + 1}>` : '<sandbox>'), text)

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
/**
 * The kind of secret `text` still holds, or null: the API key, a throwaway id, an `e2b_` string (E2B keys and tokens), a
 * UUID, or a run of 32 or more token characters. Lowercase words joined by underscores, as E2B's error codes are
 * (`sandbox_snapshot_guest_agent_unresponsive`), are not tokens. It names the kind, never the value.
 */
export function leak(text, { apiKey, ids = [] } = {}) {
  if (apiKey && text.includes(apiKey)) return 'the API key'
  if (ids.some(id => text.includes(id))) return 'a sandbox id'
  if (text.includes('e2b_')) return 'an e2b_ string'
  if (UUID.test(text)) return 'a UUID'
  if ((text.match(/[\w-]{32,}/g) ?? []).some(run => !/^[a-z]+(?:_[a-z]+)*$/.test(run))) return 'a run of 32 or more token characters'
  return null
}

/**
 * One recording as fixture text: `head`, the request and the answer as keptResponse keeps it (or `hung`), every throwaway id
 * redacted, and for a failure the error the real SDK throws when the redacted answer is replayed (sdkError). Text that still
 * holds a secret is not returned; `leak` names its kind.
 * @param {object} head case, step, cell, recordedAt, e2bSha and sdk
 * @param {{ request?: object, answer?: { status?: number, headers?: Headers, body?: any, hung?: boolean, ms: number }, sdkPath?: object, notes?: object }} entry
 * @param {{ ids: string[], apiKey: string }} secrets
 * @returns {Promise<{ text?: string, leak: string | null }>}
 */
export async function fixtureText(head, { request, answer, sdkPath, notes }, { ids, apiKey }) {
  const fixture = { ...head, recorded: true,
    ...(answer && { raw: { request, ...(answer.hung ? { hung: true } : { response: keptResponse(answer) }), ms: answer.ms } }),
    ...(sdkPath && { sdkPath }), ...(notes && { notes }) }
  const redacted = JSON.parse(redactIds(JSON.stringify(fixture), ids))
  if (redacted.raw && (redacted.raw.hung || redacted.raw.response.status >= 300)) {
    const { call, error } = await sdkError(redacted)
    redacted.sdkPath = { call, replayed: true, error: describeError(error) }
  }
  const text = `${JSON.stringify(redacted, null, 2)}\n`
  const found = leak(text, { apiKey, ids })
  return found ? { leak: found } : { text, leak: null }
}

/** An answer for the terminal: status, error code and duration, or how long it went unanswered; never its message. */
const line = (a) => a.hung ? `no answer in ${a.ms} ms` : `${a.status}${a.body?.error_code ? ` ${a.body.error_code}` : ''} in ${a.ms} ms`
const failed = (a) => a.hung || a.status >= 300

async function main() {
  const { cmd, step, cell, lose } = recorderArgs(process.argv.slice(2), process.env)
  const apiKey = process.env.E2B_API_KEY
  const api = new ApiClient(new ConnectionConfig({ apiKey, apiUrl: process.env.E2B_API_URL, retries: 0 })).api
  const fresh = cmd === 'guest-unresponsive' || step === 'prepare'
  if (fresh && existsSync(STATE)) throw new Error('a recording run is open: run cleanup first')
  if (!fresh && !existsSync(STATE)) throw new Error('no recording run is open')
  const state = fresh ? { run: randomUUID(), cell, case: cmd, ids: [] } : JSON.parse(readFileSync(STATE, 'utf8'))
  if (state.cell !== cell) throw new Error(`the open run is in ${state.cell}, not CELL ${cell}`)
  if (cmd === 'full-cell' && state.case !== cmd) throw new Error(`the open run is ${state.case}: run cleanup first`)
  if (step === 'prepare' || step === 'fill') await assertOnlyThrowaways(Sandbox, lose)
  const save = () => writeFileSync(STATE, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  if (fresh) save()
  const versions = {
    e2bSha: readFileSync(new URL('../prod/terraform.tfvars', import.meta.url), 'utf8').match(/^e2b_sha\s*=\s*"([^"]+)"/m)[1],
    sdk: `e2b ${JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).dependencies.e2b}`,
  }

  /** One API request with no SDK retries, bounded at 75 s, past the API's own 70 s: the answer, or `hung` at the bound. */
  async function raw(path, { id, body }) {
    if (path !== CREATE) await assertMine(Sandbox, state.run, id)
    const t = performance.now()
    try {
      const { data, error, response } = await api.POST(path, { params: { path: { sandboxID: id } }, body, signal: AbortSignal.timeout(75_000) })
      return { status: response.status, headers: response.headers, body: data ?? error, ms: Math.round(performance.now() - t) }
    } catch (e) {
      if (e?.name !== 'TimeoutError') throw e
      return { hung: true, ms: Math.round(performance.now() - t) }
    }
  }

  /** Writes `<case>-<step>.<cell>.json`; a fixture that would leak is not written, and the run exits 1. */
  async function record(name, entry) {
    const { text, leak: found } = await fixtureText({ case: state.case, step: name, cell, recordedAt: new Date().toISOString(), ...versions }, entry, { ids: state.ids, apiKey })
    if (found) { process.exitCode = 1; return console.log(`${name}: NOT written, the fixture would hold ${found}`) }
    mkdirSync(FIXTURES, { recursive: true })
    writeFileSync(new URL(`${state.case}-${name}.${cell}.json`, FIXTURES), text)
    const { sdkPath } = JSON.parse(text)
    console.log(`${name}: ${entry.answer ? line(entry.answer) : `${entry.sdkPath.ms} ms`}${sdkPath?.error ? `, SDK ${sdkPath.error.class} ${sdkPath.error.statusCode ?? ''}` : ''}`)
  }

  /** A throwaway of `template`, its id saved before anything else; the create's request and answer either way. */
  async function throwaway(template) {
    const body = { templateID: template, timeout: TTL_S }
    const answer = await raw(CREATE, { body: { ...body, metadata: { purpose: PURPOSE, run: state.run } } })
    const request = { method: 'POST', path: CREATE, body }
    if (failed(answer)) return { request, answer }
    state.ids.push(answer.body.sandboxID)
    save()
    await assertMine(Sandbox, state.run, answer.body.sandboxID)
    return { request, answer, sbx: await Sandbox.connect(answer.body.sandboxID, { timeoutMs: TTL_S * 1000 }) }
  }

  /** Kills every throwaway of this run, found by its nonce, then forgets the run. */
  async function cleanup() {
    const own = await listAll(Sandbox, { metadata: { purpose: PURPOSE, run: state.run } })
    for (const { sandboxId } of own) { await assertMine(Sandbox, state.run, sandboxId); await Sandbox.kill(sandboxId) }
    const left = (await listAll(Sandbox, { metadata: { purpose: PURPOSE, run: state.run } })).length
    if (left) throw new Error(`cleanup: ${left} throwaways of this run remain; run cleanup again`)
    rmSync(STATE)
    console.log(`cleanup: killed ${own.length}; ${(await listAll(Sandbox, { metadata: { purpose: PURPOSE } })).length} recording throwaways of other runs remain in the cell`)
  }

  if (cmd === 'cleanup') return cleanup()

  if (cmd === 'guest-unresponsive') {
    try {
      const { answer, sbx } = await throwaway('mumbo-child')
      if (!sbx) throw new Error(`the throwaway's create answered ${line(answer)}`)
      const id = sbx.sandboxId
      // Detached, so the command returns before envd stops.
      await sbx.commands.run("setsid sh -c 'sleep 2; kill -STOP $(pidof envd)' </dev/null >/dev/null 2>&1 &", { user: 'root' })
      await sleep(5000)
      const t = performance.now()
      const hung = await sbx.commands.run('true', { timeoutMs: 5000 }).then(() => null, e => e)
      await record('command', { sdkPath: { call: 'commands.run', replayed: false, ms: Math.round(performance.now() - t), error: describeError(hung) } })
      const strict = { requireHealthyGuest: true }
      let paused = await raw(PAUSE, { id, body: strict })
      await record('pause-strict', { request: { method: 'POST', path: PAUSE, body: strict }, answer: paused })
      if (paused.status === 503) {
        paused = await raw(PAUSE, { id, body: {} })
        await record('pause', { request: { method: 'POST', path: PAUSE, body: {} }, answer: paused })
      }
      if (failed(paused)) throw new Error(`the throwaway did not pause: ${line(paused)}`)
      const notes = { envdUnresponsiveAtPause: Boolean((await Sandbox.getInfo(id)).envdUnresponsiveAtPause) }
      for (const [name, body] of [['resume', { timeout: 900 }], ['resume-2', { timeout: 900 }], ['resume-reboot', { timeout: 900, memory: false }]]) {
        const resumed = await raw(CONNECT, { id, body })
        await record(name, { request: { method: 'POST', path: CONNECT, body }, answer: resumed, notes })
        // A resume that works leaves the box running, so a later connect would measure a keepalive, not a resume.
        if (!failed(resumed)) { console.log(`${name} resumed the throwaway; later resumes not recorded`); break }
      }
    } finally { await cleanup() }
    return
  }

  if (step === 'prepare') {
    const { answer, sbx } = await throwaway('mumbo-child')
    if (!sbx) throw new Error(`the victim's create answered ${line(answer)}; run cleanup`)
    const paused = await raw(PAUSE, { id: sbx.sandboxId, body: {} })
    if (failed(paused)) throw new Error(`the victim did not pause: ${line(paused)}; run cleanup`)
    return console.log(`prepare: victim created in ${answer.ms} ms and paused in ${paused.ms} ms`)
  }

  if (step === 'fill') {
    let template = 'mumbo-project'
    for (let n = 1; n <= MAX_CREATES; n++) {
      const { request, answer, sbx } = await throwaway(template)
      if (sbx) {
        const t = performance.now()
        const touched = await sbx.commands.run(TOUCH, { user: 'root', timeoutMs: 300_000 }).then(() => `touched in ${Math.round(performance.now() - t)} ms`, e => `not touched: ${e.constructor.name}`)
        console.log(`filler ${n} ${template}: ${line(answer)}, memory ${touched}`)
        continue
      }
      await record(template === 'mumbo-project' ? 'create-project' : 'create', { request, answer })
      if (template === 'mumbo-child') return
      template = 'mumbo-child'
    }
    throw new Error(`fill: ${MAX_CREATES} creates and the cell never refused one; run cleanup`)
  }

  // step === 'resume': the victim, the run's first throwaway.
  const body = { timeout: 900 }
  await record('resume', { request: { method: 'POST', path: CONNECT, body }, answer: await raw(CONNECT, { id: state.ids[0], body }) })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((e) => { console.error(`record-resume: ${e.message}`); process.exit(1) })
