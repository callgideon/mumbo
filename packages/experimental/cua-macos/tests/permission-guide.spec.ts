/** Native permission preparation belongs to the macOS provider. */
import { expect, it } from 'vitest'
import { CuaConfig } from '@deepseek-ai/dsh-cua'
import { Config } from '../src/index.ts'
import { createPermissionParameters, PermissionGuideParameters, PermissionSettingsParameters } from '../src/permission-guide.ts'

it('keeps the guide interval in macOS configuration and rejects invalid bounds', () => {
  expect(CuaConfig({})).not.toHaveProperty('permissionPollIntervalMs')
  expect(Config({}).permissionPollIntervalMs).toBe(1000)
  expect(Config({ permissionPollIntervalMs: 250 }).permissionPollIntervalMs).toBe(250)
  for (const permissionPollIntervalMs of [99, 100.5, 2 ** 31]) expect(() => Config({ permissionPollIntervalMs })).toThrow()
})

it.each(['en', 'ja', 'es', 'fr', 'de', 'ru', 'pt'])('prepares both permissions in %s without sending settings-only callers guide fields', (locale) => {
  const parameters = createPermissionParameters(250)
  for (const permission of ['accessibility', 'screenRecording'] as const) {
    const guide = parameters('requestPermission', permission, locale)
    expect(PermissionGuideParameters.parse(guide)).toMatchObject({ pollIntervalMs: 250 })
    expect(guide.instruction).toContain('{application}')
    expect(guide.instruction).not.toContain('{permission}')
    const settings = parameters('openPermissionSettings', permission, locale)
    expect(settings).toEqual({ permission, settingsMessage: guide.settingsMessage })
    expect(PermissionSettingsParameters.parse(settings)).toEqual({ settingsMessage: guide.settingsMessage })
  }
})

it('matches language variants and falls back to English for unsupported languages', () => {
  const parameters = createPermissionParameters(2000)
  expect(parameters('requestPermission', 'accessibility', 'DE-AT')).toEqual({
    permission: 'accessibility', pollIntervalMs: 2000,
    instruction: 'Ziehe {application} in die Liste oben, um Barrierefreiheit zu erlauben', backLabel: 'Zurück', finderLabel: 'Im Finder anzeigen',
    unavailableMessage: 'Anwendung nicht verfügbar. Aktiviere Computer Use erneut.',
    settingsMessage: 'Öffne Systemeinstellungen > Datenschutz & Sicherheit > Barrierefreiheit.',
  })
  expect(parameters('requestPermission', 'screenRecording', 'it')).toEqual(parameters('requestPermission', 'screenRecording', 'en'))
  expect(() => PermissionGuideParameters.parse({ ...parameters('requestPermission', 'accessibility', 'en'), pollIntervalMs: 0 })).toThrow()
  expect(() => PermissionSettingsParameters.parse({ settingsMessage: '' })).toThrow()
})
