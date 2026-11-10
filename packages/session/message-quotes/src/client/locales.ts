/** Copy owned by the Quote interaction plugin. */

/** Quote plugin dictionary namespace. */
export const NS = 'messageQuotes'

/** Supported Quote interaction copy keys. */
export type MessageQuotesKey = keyof typeof en

/** English dictionary. */
export const en = {
  'quote.add': 'Quote text',
} satisfies Record<string, string>

/** Japanese dictionary. */
export const ja = {
  'quote.add': 'テキストを引用',
} satisfies Record<MessageQuotesKey, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'quote.add': 'Texto de cotización',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'quote.add': 'Texte de citation',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'quote.add': 'Zitattext',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'quote.add': 'Текст цитаты',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'quote.add': 'Citação de texto',
} satisfies Record<keyof typeof en, string>
