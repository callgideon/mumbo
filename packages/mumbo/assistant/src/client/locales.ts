/** Mumbo's sidebar entry copy for every Client locale. */

/** Locale namespace of the assistant's Client copy. */
export const NS = 'mumboAssistant'

/** English copy. */
export const en = {
  'entry': 'Mumbo',
} satisfies Record<string, string>

/** Keys every assistant dictionary defines. */
export type MumboAssistantKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Mumbo's sidebar entry. */
    mumboAssistant: MumboAssistantKey
  }
}

/** Japanese copy. */
export const ja = { 'entry': 'Mumbo' } satisfies Record<MumboAssistantKey, string>
/** Spanish copy. */
export const es = { 'entry': 'Mumbo' } satisfies Record<MumboAssistantKey, string>
/** French copy. */
export const fr = { 'entry': 'Mumbo' } satisfies Record<MumboAssistantKey, string>
/** German copy. */
export const de = { 'entry': 'Mumbo' } satisfies Record<MumboAssistantKey, string>
/** Russian copy. */
export const ru = { 'entry': 'Mumbo' } satisfies Record<MumboAssistantKey, string>
/** Portuguese copy. */
export const pt = { 'entry': 'Mumbo' } satisfies Record<MumboAssistantKey, string>
