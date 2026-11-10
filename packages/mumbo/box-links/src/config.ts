/** Box page links and views shared by the Host and Client halves. */
import z from '@deepseek-ai/schemastery'

/** How the Host brings the desktop's Chrome window to the front; the desktop itself keeps Chrome running. */
export interface BrowserConfig {
  /** X display Chrome runs on, passed as `DISPLAY` to every command. */
  display: string
  /** Absolute X authority file passed as `XAUTHORITY`; omission removes an inherited `XAUTHORITY`. */
  xauthority?: string
  /**
   * Text that a Chrome window's WM_CLASS, `res_name.res_class` as `wmctrl -lx` prints it, contains, compared without
   * regard to case: wmctrl's own `-x` matching.
   */
  windowClass: string
  /** `wmctrl` executable: an absolute path or a name looked up on `PATH`. */
  wmctrl: string
  /** Milliseconds the call waits, from its start, for a Chrome window to exist, activate, and maximize. */
  timeoutMs: number
}

/** Absolute links from a box's Web page to the pages the box edge serves beside it, and the Browser tab's Host call. */
export interface Config {
  /** Box home page: the person's assistant, desktop, and shared projects. */
  home: string
  /** Desktop live view; omitted for a box without a desktop, such as a project box. */
  desktop?: string
  /** The Browser tab's Chrome control; omitted for a box without the Browser tab. Requires `desktop`. */
  browser?: BrowserConfig
}

/** What the page bootstrap carries to the Client half. */
export interface PageLinks {
  /** Box home page. */
  home: string
  /** Desktop live view, shown as the Desktop tab and, with `browser`, the Browser tab. */
  desktop?: string
  /** True on the owner's page when the Host serves the Browser tab's call. */
  browser?: boolean
  /** True on the owner's page when the Host also serves the Browser tab's take-over route, with browser consent loaded. */
  takeover?: boolean
}

/**
 * Who has the browser, as browser consent's service reports it: `free` for the assistant, `taking` while a take over
 * still closes the assistant's browser connections, `held` once none is open, and `unfinished` with the failure of a
 * take over that did not finish.
 */
export type TakeoverHold =
  | { kind: 'free' }
  | { kind: 'taking' }
  | { kind: 'held' }
  | { kind: 'unfinished'; failure: string }

/** The take-over route's answer: who has the browser, and why a requested change failed. */
export interface TakeoverState {
  /** Who has the browser after the request. */
  hold: TakeoverHold
  /** On a POST answer with status 500, why the requested change failed. */
  failure?: string
}

const link = z.string().pattern(/^https?:\/\/[^/\s]+\/\S*$/)
const program = z.string().pattern(/^(\/\S+|[^\s/]+)$/)

const Browser: z<BrowserConfig> = z.object({
  display: z.string().pattern(/^[\w.-]*:\d+(\.\d+)?$/).default(':1').description('X display Chrome runs on.'),
  xauthority: z.string().pattern(/^\//).description('Absolute X authority file for the display; omit for a display without one.'),
  // Matches Google Chrome's `google-chrome (<profile>).Google-chrome` and Debian Chromium's `chromium (<profile>).Chromium`.
  windowClass: z.string().min(1).default('chrom').description('Text a Chrome window\'s WM_CLASS contains, ignoring case.'),
  wmctrl: program.default('wmctrl').description('wmctrl executable.'),
  timeoutMs: z.number().step(1).min(1).max(2 ** 31 - 1).default(15_000)
    .description('Milliseconds the call waits for a Chrome window to exist, activate, and maximize.'),
})

/**
 * Validate the links and the Browser tab's Chrome control; each link is an absolute HTTP(S) URL with a path, so no
 * script or relative URL reaches the page.
 */
export const Config: z<Config> = z.object({
  home: link.required().description('Absolute URL of the box home page.'),
  desktop: link.description('Absolute URL of the desktop live view; omit it for a box without a desktop.'),
  // An omitted object stays omitted rather than becoming `{}`, which enables the Browser tab with every default.
  browser: Browser.default(undefined as never)
    .description('How the Browser tab brings the desktop\'s Chrome to the front; omit it for a box without the Browser tab.'),
})

/** Validate the bootstrap links again in the browser. */
export const PageLinks: z<PageLinks> = z.object({
  home: link.required(),
  desktop: link,
  browser: z.boolean(),
  takeover: z.boolean(),
})

/** Validate a take-over route answer in the browser. */
export const TakeoverState: z<TakeoverState> = z.object({
  hold: z.union([
    z.object({ kind: z.const('free').required() }),
    z.object({ kind: z.const('taking').required() }),
    z.object({ kind: z.const('held').required() }),
    z.object({ kind: z.const('unfinished').required(), failure: z.string().required() }),
  ]).required(),
  failure: z.string(),
})

/** Page bootstrap global that carries the validated {@link PageLinks} to the Client half. */
export const BOX_LINKS_GLOBAL = '__MUMBO_BOX_LINKS__'

/** Owner-only exact route that brings Chrome to the front; the Client posts to its document-relative form. */
export const BROWSER_FRONT_PATH = '/api/box-links.browser-front'

/**
 * Owner-only exact route through which the Browser tab reads, takes over, and hands back the browser: GET answers a
 * {@link TakeoverState}, and POST with `{ takenOver }` changes it and answers the same.
 */
export const BROWSER_TAKEOVER_PATH = '/api/box-links.browser-takeover'
