/** Box page links and views shared by the Host and Client halves. */
import z from '@deepseek-ai/schemastery'

/** How the Host brings the desktop's Chrome to the front, and starts Chrome when no Chrome window shows. */
export interface BrowserConfig {
  /** X display Chrome runs on, passed as `DISPLAY` to every command. */
  display: string
  /** Absolute X authority file passed as `XAUTHORITY`; omission removes an inherited `XAUTHORITY`. */
  xauthority?: string
  /** Desktop user that a Chrome started here runs as. */
  user: string
  /** Chrome executable the desktop runs: an absolute path or a name looked up on `PATH`. */
  chrome: string
  /** The desktop launcher's own Chrome flags, so a Chrome started here is the one the desktop would start. */
  chromeArgs: string[]
  /** Case-insensitive xdotool regular expression matching the window class of Chrome's windows. */
  windowClass: string
  /** `xdotool` executable: an absolute path or a name looked up on `PATH`. */
  xdotool: string
  /** Deadline in milliseconds for each command, including the wait for a started Chrome's first window. */
  timeoutMs: number
  /** Milliseconds a timed-out command may take to exit after termination starts. */
  graceMs: number
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
}

const link = z.string().pattern(/^https?:\/\/[^/\s]+\/\S*$/)
const program = z.string().pattern(/^(\/\S+|[^\s/]+)$/)
const ms = z.number().step(1).min(1).max(2 ** 31 - 1)

const Browser: z<BrowserConfig> = z.object({
  display: z.string().pattern(/^[\w.-]*:\d+(\.\d+)?$/).default(':1').description('X display Chrome runs on.'),
  xauthority: z.string().pattern(/^\//).description('Absolute X authority file for the display; omit for a display without one.'),
  user: z.string().pattern(/^[a-z_][a-z0-9_-]*$/).default('browser').description('Desktop user a Chrome started here runs as.'),
  chrome: program.default('google-chrome-stable').description('Chrome executable the desktop runs.'),
  chromeArgs: z.array(z.string().pattern(/^--\S/)).required().description('The desktop launcher\'s own Chrome flags.'),
  windowClass: z.string().min(1).default('google-chrome|chromium').description('xdotool class pattern of Chrome\'s windows.'),
  xdotool: program.default('xdotool').description('xdotool executable.'),
  timeoutMs: ms.default(15_000).description('Deadline of each command in milliseconds.'),
  graceMs: ms.default(1000).description('Exit allowance after a timed-out command is terminated.'),
})

/**
 * Validate the links and the Browser tab's Chrome control; each link is an absolute HTTP(S) URL with a path, so no
 * script or relative URL reaches the page.
 */
export const Config: z<Config> = z.object({
  home: link.required().description('Absolute URL of the box home page.'),
  desktop: link.description('Absolute URL of the desktop live view; omit it for a box without a desktop.'),
  // An omitted object must not become `{}` and fail its required flags.
  browser: Browser.default(undefined as never)
    .description('How the Browser tab brings the desktop\'s Chrome to the front; omit it for a box without the Browser tab.'),
})

/** Validate the bootstrap links again in the browser. */
export const PageLinks: z<PageLinks> = z.object({
  home: link.required(),
  desktop: link,
  browser: z.boolean(),
})

/** Page bootstrap global that carries the validated {@link PageLinks} to the Client half. */
export const BOX_LINKS_GLOBAL = '__MUMBO_BOX_LINKS__'

/** Owner-only exact route that brings Chrome to the front; the Client posts to its document-relative form. */
export const BROWSER_FRONT_PATH = '/api/box-links.browser-front'
