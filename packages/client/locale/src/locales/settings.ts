/** `settings.locale` namespace dictionaries (the Language row's copy). */

/** The settings.locale namespace key union. */
export type SettingsLocaleKey = keyof typeof en

/** English dictionary (the key-set source of truth). */
export const en = {
  'language.title': 'Language',
} satisfies Record<string, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'language.title': '言語',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'language.title': 'Idioma',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'language.title': 'Langue',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'language.title': 'Sprache',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'language.title': 'Язык',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'language.title': 'Idioma',
} satisfies Record<keyof typeof en, string>
