/**
 * Translation from model-written key chords to xdotool key arguments.
 * @module @deepseek-ai/dsh-computer-use-x11/keys
 */

/** Modifier names accepted by pointer actions and chords; each is also an xdotool key name. */
export const MODIFIERS = ['ctrl', 'shift', 'alt', 'super'] as const

/** One modifier held during a pointer action or chord. */
export type Modifier = typeof MODIFIERS[number]

/** Common spellings mapped to the X keysym names that xdotool accepts. */
const ALIASES: Readonly<Record<string, string>> = {
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt',
  super: 'super', win: 'super', windows: 'super', meta: 'super',
  enter: 'Return', esc: 'Escape', del: 'Delete', ins: 'Insert', pgup: 'Page_Up', pgdn: 'Page_Down',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', printscreen: 'Print',
}

/**
 * Named X keysyms accepted besides aliases, function keys and single characters. The list is closed:
 * xdotool `key` runs any argument that names an xdotool command, such as `exec`, as a chained command.
 */
const KEYSYMS: readonly string[] = [
  'Return', 'Escape', 'Tab', 'BackSpace', 'Delete', 'Insert', 'Home', 'End', 'Prior', 'Next', 'Page_Up', 'Page_Down',
  'Up', 'Down', 'Left', 'Right', 'space', 'Menu', 'Print', 'Scroll_Lock', 'Pause', 'Break', 'Caps_Lock', 'Num_Lock',
  'Control_L', 'Control_R', 'Shift_L', 'Shift_R', 'Alt_L', 'Alt_R', 'Super_L', 'Super_R',
  ...Array.from({ length: 10 }, (_, digit) => `KP_${digit}`),
  'KP_Enter', 'KP_Add', 'KP_Subtract', 'KP_Multiply', 'KP_Divide', 'KP_Decimal', 'KP_Separator', 'KP_Equal',
  'KP_Home', 'KP_End', 'KP_Up', 'KP_Down', 'KP_Left', 'KP_Right', 'KP_Prior', 'KP_Next', 'KP_Insert', 'KP_Delete', 'KP_Begin',
  'XF86AudioMute', 'XF86AudioLowerVolume', 'XF86AudioRaiseVolume', 'XF86AudioMicMute',
  'XF86AudioPlay', 'XF86AudioPause', 'XF86AudioStop', 'XF86AudioNext', 'XF86AudioPrev',
  'XF86MonBrightnessUp', 'XF86MonBrightnessDown', 'XF86Back', 'XF86Forward', 'XF86Reload', 'ISO_Level3_Shift',
]

const normalize = (token: string) => token.toLowerCase().replace(/[-_]/g, '')

/** Every accepted name, keyed by lowercase spelling without `-` or `_`. */
const NAMED: ReadonlyMap<string, string> = new Map([
  ...KEYSYMS.map(name => [normalize(name), name] as const),
  ...Object.entries(ALIASES),
])

/** macOS-only names that have no key on an X11 desktop. */
const UNAVAILABLE = new Set(['cmd', 'command', 'fn'])

function keysym(token: string, modified: boolean): string {
  const named = NAMED.get(normalize(token))
  if (named !== undefined) return named
  if (UNAVAILABLE.has(normalize(token))) throw new Error(`"${token}" has no key on this Linux desktop; use ctrl for application shortcuts`)
  const functionKey = /^f([1-9]|1\d|2[0-4])$/i.exec(token)
  if (functionKey) return `F${functionKey[1]}`
  const unicode = /^U([0-9A-F]{4,6})$/i.exec(token)
  if (unicode) return `U${(unicode[1] as string).toUpperCase()}`
  const codePoint = token.codePointAt(0)
  if (codePoint !== undefined && String.fromCodePoint(codePoint) === token && !/\p{C}/u.test(token)) {
    if (/^[A-Za-z]$/.test(token)) return modified ? token.toLowerCase() : token
    if (/^[0-9]$/.test(token)) return token
    // Xlib resolves `U<hex>` to the Latin-1 or Unicode keysym for this character.
    return `U${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
  }
  throw new Error(`Unknown key "${token}"; use a key name such as Return, Escape, Tab, BackSpace, Delete, Page_Up, F5, KP_Enter or a single character`)
}

function chordTokens(chord: string): string[] {
  if (chord === '+') return ['+']
  const tokens = chord.endsWith('++') ? [...chord.slice(0, -2).split('+'), '+'] : chord.split('+')
  if (tokens.includes('')) throw new Error(`Malformed key chord "${chord}"`)
  return tokens
}

/**
 * Translate space-separated chords such as `ctrl+shift+t Return` into xdotool `key` arguments.
 * Letters in a chord with modifiers are lowercased so Shift is pressed only when named. Only aliases, the named
 * keysyms above, F1 to F24, `U<hex>` code points and single printable characters are accepted, so no argument can
 * name an xdotool command.
 * @param keys - one or more chords separated by whitespace; `+` joins a chord's modifiers and final key.
 * @returns one xdotool key sequence per chord.
 * @throws Error naming the malformed chord, the non-modifier prefix, or the unknown or unavailable key.
 */
export function translateKeys(keys: string): string[] {
  const chords = keys.trim().split(/\s+/).filter(chord => chord !== '')
  if (chords.length === 0) throw new Error('keys must name at least one key')
  return chords.map((chord) => {
    const tokens = chordTokens(chord)
    const modifiers = tokens.slice(0, -1).map((token) => {
      const name = keysym(token, true)
      if (!(MODIFIERS as readonly string[]).includes(name)) {
        throw new Error(`"${token}" in "${chord}" is not a modifier; put only ctrl, shift, alt or super before the final key`)
      }
      return name
    })
    return [...modifiers, keysym(tokens.at(-1) as string, modifiers.length > 0)].join('+')
  })
}

/** Names {@link translateKeys} and the release arguments emit besides function keys, `U<hex>`, letters and digits. */
const EMITTED: ReadonlySet<string> = new Set([...MODIFIERS, ...KEYSYMS])

/**
 * Whether one xdotool key argument consists only of names this module emits, joined by `+`; no such argument names an
 * xdotool command.
 * @param argument - one argument of `key`, `keydown` or `keyup`.
 * @returns true when every `+`-separated part is a modifier, a listed keysym, F1 to F24, `U<hex>`, a letter or a digit.
 */
export function isKeyArgument(argument: string): boolean {
  return argument.split('+').every(part => EMITTED.has(part) || /^(?:F(?:[1-9]|1\d|2[0-4])|U[0-9A-F]{4,6}|[A-Za-z0-9])$/.test(part))
}
