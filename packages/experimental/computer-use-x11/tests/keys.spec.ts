/** Model-written key chords translated to xdotool key names. */
import { describe, expect, it } from 'vitest'
import { translateKeys } from '../src/keys.ts'

describe('translateKeys', () => {
  it.each([
    ['Return', ['Return']],
    ['enter', ['Return']],
    ['Ctrl+Shift+T', ['ctrl+shift+t']],
    ['control+option+Delete', ['ctrl+alt+Delete']],
    ['meta+e win+l', ['super+e', 'super+l']],
    ['ctrl+a  BackSpace', ['ctrl+a', 'BackSpace']],
    ['Page-Down arrow_up esc', ['Page_Down', 'Up', 'Escape']],
    ['alt+f4 F12', ['alt+F4', 'F12']],
    ['A 1 ctrl+1', ['A', '1', 'ctrl+1']],
    ['ctrl++ + ctrl+- /', ['ctrl+U002B', 'U002B', 'ctrl+U002D', 'U002F']],
    ['é ✓', ['U00E9', 'U2713']],
    ['KP_Enter XF86AudioMute', ['KP_Enter', 'XF86AudioMute']],
  ])('translates %j', (keys, expected) => {
    expect(translateKeys(keys)).toEqual(expected)
  })

  it.each([
    ['   ', 'keys must name at least one key'],
    ['ctrl+', 'Malformed key chord "ctrl+"'],
    ['a+b', '"a" in "a+b" is not a modifier'],
    ['cmd+c', '"cmd" has no key on this Linux desktop; use ctrl for application shortcuts'],
    ['fn', '"fn" has no key'],
    ['ctrl+{x}', 'Unknown key "{x}"'],
  ])('rejects %j', (keys, message) => {
    expect(() => translateKeys(keys)).toThrow(message)
  })
})
