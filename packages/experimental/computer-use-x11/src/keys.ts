/**
 * Translation from model-written key chords to xdotool key arguments.
 * @module @deepseek-ai/dsh-computer-use-x11/keys
 */

/** Modifier names accepted by pointer actions and chords; each is also an xdotool key name. */
export const MODIFIERS = ['ctrl', 'shift', 'alt', 'super'] as const

/** One modifier held during a pointer action or chord. */
export type Modifier = typeof MODIFIERS[number]

/** Common key names, keyed by lowercase spelling without `-`, `_`, or spaces, mapped to X keysym names. */
const ALIASES: Readonly<Record<string, string>> = {
  ctrl: 'ctrl', control: 'ctrl', shift: 'shift', alt: 'alt', option: 'alt', opt: 'alt',
  super: 'super', win: 'super', windows: 'super', meta: 'super',
  enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'space',
  backspace: 'BackSpace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End', pageup: 'Page_Up', pgup: 'Page_Up', pagedown: 'Page_Down', pgdn: 'Page_Down',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  capslock: 'Caps_Lock', printscreen: 'Print', print: 'Print', menu: 'Menu',
}

/** macOS-only names that have no key on an X11 desktop. */
const UNAVAILABLE = new Set(['cmd', 'command', 'fn'])

function keysym(token: string, modified: boolean): string {
  const normalized = token.toLowerCase().replace(/[-_\s]/g, '')
  const alias = ALIASES[normalized]
  if (alias !== undefined) return alias
  if (UNAVAILABLE.has(normalized)) throw new Error(`"${token}" has no key on this Linux desktop; use ctrl for application shortcuts`)
  const functionKey = /^f([1-9]|1\d|2[0-4])$/i.exec(token)
  if (functionKey) return `F${functionKey[1]}`
  const codePoint = token.codePointAt(0)
  if (codePoint !== undefined && String.fromCodePoint(codePoint) === token) {
    if (/^[A-Za-z]$/.test(token)) return modified ? token.toLowerCase() : token
    if (/^[0-9]$/.test(token)) return token
    // Xlib resolves `U<hex>` to the Latin-1 or Unicode keysym for this character.
    return `U${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
  }
  if (/^[A-Za-z0-9_]+$/.test(token)) return token
  throw new Error(`Unknown key "${token}"`)
}

function chordTokens(chord: string): string[] {
  if (chord === '+') return ['+']
  const tokens = chord.endsWith('++') ? [...chord.slice(0, -2).split('+'), '+'] : chord.split('+')
  if (tokens.includes('')) throw new Error(`Malformed key chord "${chord}"`)
  return tokens
}

/**
 * Translate space-separated chords such as `ctrl+shift+t Return` into xdotool `key` arguments.
 * Letters in a chord with modifiers are lowercased so Shift is pressed only when named.
 * @param keys - one or more chords separated by whitespace; `+` joins a chord's modifiers and final key.
 * @returns one xdotool key sequence per chord.
 * @throws Error naming the malformed chord, the non-modifier prefix, or the unavailable key.
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
