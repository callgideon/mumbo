// Daily model budgets per principal, shared by every edge replica through the store (store.mjs): a request count
// (budget) and a token count read from the model's responses (tokenBudget). Both counters are read before a call and
// added to without waiting (spec R6b ruling 2), so a principal can pass its limit by the calls that were admitted
// together, and by the calls each edge task admits within OPEN_MS of reading the count open.

/** How long one edge task keeps a principal's open verdict (a count under its limit) before reading the count again. */
export const OPEN_MS = 10_000
const day = (ms) => new Date(ms).toISOString().slice(0, 10)

/** `check` with each principal's open verdict kept OPEN_MS; a closed verdict is checked again on every call. */
function openFor(now, check) {
  const until = new Map()  // principal -> epoch ms
  return async (principal) => {
    if ((until.get(principal) ?? 0) > now()) return true
    const open = await check(principal)
    if (open) until.set(principal, now() + OPEN_MS); else until.delete(principal)
    return open
  }
}

/**
 * Per-principal daily request budget.
 * @param {{ store: object, limit: number, now?: () => number }} deps - `now` is epoch ms.
 * @returns {{ allow(principal: string): Promise<boolean>, charge(principal: string): void }}
 *   `allow` is true while today's count is under `limit`, an open answer kept OPEN_MS; `charge` adds one call to today's
 *   count without waiting, and logs a failed write. A caller charges only a call it admitted.
 */
export function budget({ store, limit, now = Date.now }) {
  const key = (principal) => `budget:${day(now())}:${principal}`
  return {
    allow: openFor(now, async (principal) => (await store.getCount(key(principal))) < limit),
    charge(principal) { store.increment(key(principal), 2 * 86_400).catch((err) => console.error('edge: request count failed', err.message)) },
  }
}

const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
const TWO_DAYS_MS = 2 * 86_400_000

/** OpenAI-style usage (prompt_tokens, completion_tokens) in the Anthropic fields, or null when `u` is not one. OpenAI and
 *  OpenRouter count completion_tokens_details.reasoning_tokens inside completion_tokens, so reasoning is only a floor. */
const openaiUsage = (u) => {
  if (u === null || typeof u !== 'object' || !('prompt_tokens' in u || 'completion_tokens' in u)) return null
  const out = [u.completion_tokens, u.completion_tokens_details?.reasoning_tokens].filter(v => Number.isSafeInteger(v) && v >= 0)
  return { input_tokens: u.prompt_tokens, output_tokens: out.length ? Math.max(...out) : undefined }
}
/** Characters of generated text in an Anthropic content block or delta, or an OpenAI message or delta. */
const generated = (d) => [d?.text, d?.thinking, d?.partial_json, d?.content, d?.reasoning, d?.reasoning_content,
  ...(Array.isArray(d?.tool_calls) ? d.tool_calls.map(t => t?.function?.arguments) : [])].reduce((n, v) => n + (typeof v === 'string' ? v.length : 0), 0)

/**
 * Daily token budget per principal: `limits.project` for `project:*` principals, `limits.user` otherwise.
 * @param {{ store: object, limits: { user: number, project: number }, now: () => number }} deps - `now` is epoch ms.
 * @returns {{ allow(principal: string): Promise<boolean>, meter(principal: string, webBody: ReadableStream, contentType: string | null, inputEstimate?: number): ReadableStream }}
 *   `allow` is false once today's tokens reach the limit; an open answer is kept OPEN_MS. `meter` passes every byte
 *   through without waiting for the store, adds the usage it reads to today's count without waiting, and logs a failed
 *   write. It reads Anthropic Messages or OpenAI Chat Completions, SSE or JSON. Without readable usage it charges an
 *   estimate instead: `inputEstimate` (default 0; OpenAI streams report input only in their last chunk) plus
 *   ceil(generated characters / 3), when an SSE body ends or is cancelled before its final usage, when a JSON body has
 *   no usage, and (input only) when a JSON body is cancelled before its end. The OpenRouter route forces streaming, so its JSON bodies are upstream errors,
 *   which the caller meters with inputEstimate 0.
 */
export function tokenBudget({ store, limits, now }) {
  const key = (principal) => `tokens:${day(now())}:${principal}`
  return {
    allow: openFor(now, async (principal) => (await store.getCount(key(principal))) < (principal.startsWith('project:') ? limits.project : limits.user)),
    meter(principal, webBody, contentType, inputEstimate = 0) {
      const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
      if (type !== 'text/event-stream' && type !== 'application/json') return webBody
      const k = key(principal)
      const add = (n) => {
        if (n > 0) store.incrementBy(k, n, TWO_DAYS_MS).catch((err) => console.error('edge: token count failed', err.message))
      }
      const decoder = new TextDecoder()
      let pending = ''
      if (type === 'application/json') {
        return webBody.pipeThrough(new TransformStream({
          transform(chunk, controller) { pending += decoder.decode(chunk, { stream: true }); controller.enqueue(chunk) },
          async flush() {
            let body
            try { body = JSON.parse(pending + decoder.decode()) } catch (err) { console.error('edge: token usage unreadable', err.message); return add(inputEstimate) }
            const usage = openaiUsage(body?.usage) ?? body?.usage
            if (USAGE_FIELDS.some(f => Number.isSafeInteger(usage?.[f]))) return add(USAGE_FIELDS.reduce((sum, f) => sum + (Number.isSafeInteger(usage[f]) ? usage[f] : 0), 0))
            const blocks = [...(Array.isArray(body?.choices) ? body.choices.map(c => c?.message) : []), ...(Array.isArray(body?.content) ? body.content : [])]
            await add(inputEstimate + Math.ceil(blocks.reduce((n, b) => n + generated(b), 0) / 3))
          },
          cancel: () => add(inputEstimate),
        }))
      }
      // SSE: the last value seen of each field wins, so message_start and message_delta usage do not double count.
      // Output text is also counted in characters; a stream that ends or is cancelled before a final usage carries
      // output tokens (a box can cancel early to dodge the charge) is billed ceil(chars / 3) instead, and at least
      // inputEstimate for input.
      const last = Object.fromEntries(USAGE_FIELDS.map((f) => [f, 0]))
      let counted = 0
      let chars = 0
      let final = false
      let finished = false
      const charge = async () => {
        const total = USAGE_FIELDS.reduce((sum, f) => sum + last[f], 0)
        const increase = total - counted
        counted = total
        await add(increase)
      }
      const event = async (line) => {
        if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') return
        try {
          const data = JSON.parse(line.slice(5))
          // Anthropic content_block_delta, or OpenAI choices[].delta.
          const deltas = data.type === 'content_block_delta' ? [data.delta ?? {}] : Array.isArray(data.choices) ? data.choices.map(c => c?.delta ?? {}) : []
          for (const d of deltas) chars += generated(d)
          const usage = data.type === 'message_start' ? data.message?.usage : data.type === 'message_delta' ? data.usage : openaiUsage(data.usage)
          if (!usage) return
          for (const f of USAGE_FIELDS) if (Number.isSafeInteger(usage[f]) && usage[f] >= 0) last[f] = usage[f]
          if (data.type !== 'message_start' && Number.isSafeInteger(usage.output_tokens)) final = true
        } catch (err) { console.error('edge: token usage unreadable', err.message); return }
        await charge()
      }
      const lines = async (end) => {
        const parts = pending.split('\n')
        pending = end ? '' : parts.pop()
        for (const line of parts) await event(line.replace(/\r$/, ''))
      }
      const finish = async () => {
        if (finished) return
        finished = true
        pending += decoder.decode()
        await lines(true)
        if (!final) {
          last.output_tokens = Math.max(last.output_tokens, Math.ceil(chars / 3))
          last.input_tokens = Math.max(last.input_tokens, inputEstimate)
        }
        await charge()
      }
      const reader = webBody.getReader()
      return new ReadableStream({
        async pull(controller) {
          let result
          try { result = await reader.read() } catch (err) { await finish(); throw err }
          const { done, value } = result
          if (done) { await finish(); controller.close(); return }
          pending += decoder.decode(value, { stream: true })
          await lines(false)
          controller.enqueue(value)
        },
        async cancel(reason) { await finish(); await reader.cancel(reason) },
      })
    },
  }
}
