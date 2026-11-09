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
    ['KP_Enter kp_0 XF86AudioMute Prior Scroll_Lock', ['KP_Enter', 'KP_0', 'XF86AudioMute', 'Prior', 'Scroll_Lock']],
    ['U00e9 u2713 shift+U00E9', ['U00E9', 'U2713', 'shift+U00E9']],
  ])('translates %j', (keys, expected) => {
    expect(translateKeys(keys)).toEqual(expected)
  })

  // xdotool runs a `key` argument that names one of its commands, so none may pass in any position.
  it.each([
    'exec', 'sleep', 'windowkill', 'windowclose', 'getactivewindow', 'getwindowfocus', 'search', 'type', 'key', 'keydown', 'keyup',
    'click', 'mousemove', 'mousedown', 'mouseup', 'windowactivate', 'windowmap', 'windowunmap', 'windowmove', 'windowsize',
    'set_window', 'set_desktop', 'behave', 'selectwindow', 'getmouselocation', 'help', 'version',
  ])('rejects the xdotool command %j alone, capitalized and inside a chord', (command) => {
    for (const keys of [command, command.toUpperCase(), `${command[0]?.toUpperCase()}${command.slice(1)}`, `ctrl+${command}`, `Return ${command} xterm`]) {
      expect(() => translateKeys(keys), keys).toThrow('Unknown key')
    }
  })

  it.each([
    ['   ', 'keys must name at least one key'],
    ['ctrl+', 'Malformed key chord "ctrl+"'],
    ['a+b', '"a" in "a+b" is not a modifier'],
    ['cmd+c', '"cmd" has no key on this Linux desktop; use ctrl for application shortcuts'],
    ['fn', '"fn" has no key'],
    ['ctrl+{x}', 'Unknown key "{x}"'],
    ['\u0007', 'Unknown key'],
    ['nosuchkey', 'Unknown key "nosuchkey"'],
  ])('rejects %j', (keys, message) => {
    expect(() => translateKeys(keys)).toThrow(message)
  })
})
