// Replays recorded E2B API answers (testing/fixtures/resume/, written by record-resume.e2e.mjs) through the real SDK, so the
// recorder and the tests learn the error class and status the edge sees for each. Not in the image: the Dockerfile copies
// only top-level modules and box/.
import { createServer } from 'node:http'
import { E2B } from 'e2b'

/** The SDK call that sends each recorded request path, on a placeholder sandbox id. */
const CALLS = [
  [/\/connect$/, 'Sandbox.connect', (Sandbox, opts) => Sandbox.connect('u1', opts)],
  [/\/pause$/, 'Sandbox.pause', (Sandbox, opts) => Sandbox.pause('u1', opts)],
  [/^\/v2\/sandboxes$/, 'Sandbox.create', (Sandbox, opts) => Sandbox.create('mumbo-child', opts)],
]

/**
 * Sends a fixture's recorded answer to the real SDK: a loopback server answers with the recorded status, kept headers and
 * body, or holds the request open when the recording `hung`, and the SDK call for the request path runs once, without retries.
 * @param {{ raw: { request: { path: string }, response?: { status: number, headers: object, body?: unknown }, hung?: boolean } }} fixture
 * @returns {Promise<{ call: string, error: Error | null }>} the SDK call's name and what it threw; null when it returned
 */
export async function sdkError({ raw }) {
  const [, call, send] = CALLS.find(([path]) => path.test(raw.request.path)) ?? []
  if (!call) throw new Error(`no SDK call replays ${raw.request.path}`)
  const server = createServer((req, res) => {
    if (raw.hung) return
    const { status, headers, body } = raw.response
    res.writeHead(status, headers).end(body === undefined || typeof body === 'string' ? body : JSON.stringify(body))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { Sandbox } = new E2B({ apiKey: 'test', apiUrl: `http://127.0.0.1:${server.address().port}` })
    return { call, error: await send(Sandbox, { retries: 0, requestTimeoutMs: raw.hung ? 200 : 2000 }).then(() => null, e => e) }
  } finally {
    server.closeAllConnections()
    server.close()
  }
}

/** What a fixture keeps of a thrown error: its class, name, statusCode (SandboxError and its subclasses) and message. */
export const describeError = (e) => e && { class: e.constructor.name, name: e.name, statusCode: e.statusCode, message: e.message }
