/** The read-only model trigger keeps the locked dimming and gains no hover fill. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/ModelSelect.module.css', import.meta.url)), 'utf8')

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`(?:^|\\n)\\s*\\.${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  if (rule === null) throw new Error(`ModelSelect.module.css has no .${selector} rule`)
  return rule[1] ?? ''
}

describe('ModelSelect trigger styles', () => {
  it('leaves the ink to :disabled, so a locked read-only trigger stays dimmed', () => {
    expect(declarations('trigger:disabled')).toContain('color: var(--dsw-alias-label-dimmed);')
    expect(declarations('trigger[data-read-only]')).not.toContain('color')
  })

  it('paints the hover fill only on a selectable, enabled trigger', () => {
    expect(declarations('trigger:hover:not(:disabled):not([data-read-only])'))
      .toContain('background: var(--dsw-alias-interactive-bg-hover);')
  })
})
