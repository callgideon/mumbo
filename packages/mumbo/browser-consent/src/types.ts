/**
 * Durable audit record of browser writes that consent allowed, and the service through which the person takes the browser over.
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

/** Who has the browser, as {@link BrowserTakeover.hold} reports it. */
export type BrowserHold =
  /** The assistant may use the browser under consent. */
  | { readonly kind: 'free' }
  /** The person took the browser over, and a take-over step is queued or running, so a browser connection may be open. */
  | { readonly kind: 'taking' }
  /** The person has the browser, and no Session's Playwright MCP server holds a connection to it. */
  | { readonly kind: 'held' }
  /**
   * The person took the browser over, but the last take-over step failed: a browser connection may still be open, or a
   * restart would hand the browser back. `failure` names each failed step.
   */
  | { readonly kind: 'unfinished'; readonly failure: string }

/**
 * The person's hold on the browser, provided as the `mumbo-browser-consent` service. While the person has taken over,
 * every Playwright MCP browser tool and every `computer` action is refused before dispatch, and once the take over
 * finishes no Session's Playwright MCP server holds a connection to the browser. No model tool changes it; the box's
 * owner-only Host call does.
 */
export interface BrowserTakeover {
  /**
   * Who has the browser now; every kind but `free` refuses the browser and desktop calls, and a takeover stays across
   * a Host restart until the person hands it back.
   */
  readonly hold: BrowserHold
  /**
   * Take the browser over. Refusal starts before this returns; the promise settles once the takeover is recorded for
   * a restart, the browser and desktop calls in flight are stopped, and every Session's browser connection is closed.
   * @returns after the browser connections are closed.
   * @throws Error naming each step that failed; the browser stays taken over, {@link hold} reports it `unfinished` until
   * a later call or a hand back succeeds, and a later call retries the steps.
   */
  takeOver(): Promise<void>
  /**
   * Hand the browser back and reconnect each live Session's browser by reading its tabs. A take over requested while
   * this runs wins, and the browser stays taken over.
   * @returns after the reconnecting reads settle; a failed read leaves the next desktop screenshot asking.
   * @throws Error when the takeover record could not be removed; the browser stays taken over, and {@link hold} keeps
   * its kind.
   */
  handBack(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Consent's service: the mounted browser provider waits for it, and the box's Host call takes the browser over through it. */
    'mumbo-browser-consent': BrowserTakeover
  }
}
