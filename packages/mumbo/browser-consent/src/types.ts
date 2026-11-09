/**
 * Durable audit record of browser writes that consent allowed.
 * @module @mumbo/browser-consent/types
 */

import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'

/** What allowed a browser write: a configured site allowance, or a one-shot user approval. */
export type BrowserWriteGrant = 'site' | 'approval'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One browser write that consent allowed, appended when its result is final; log-only audit, never
     * model-visible. `tool` is the upstream Playwright MCP tool name, `site` the origin of Playwright's
     * current tab when it could be read, `grant` what allowed the write, and `outcome` whether the final
     * tool result succeeded (`failed` includes a refusal by a later policy).
     */
    'browser-consent/write': {
      callId: ToolCallId
      tool: string
      site?: string
      grant: BrowserWriteGrant
      outcome: 'succeeded' | 'failed'
    }
  }
}
