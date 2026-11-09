/** Locale-owned code renderer name and CodeBlock controls. */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Code document implementation name and copy controls. */
    sidebarCodePreview: keyof typeof en
  }
}

/** English dictionary with the same keys. */
export const en = {
  title: 'Code',
  copy: 'Copy',
  copied: 'Copied',
} satisfies Record<string, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': 'コード',
  'copy': 'コピー',
  'copied': 'コピーしました',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'Código',
  copy: 'Copiar',
  copied: 'Copiado',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: 'Coder',
  copy: 'Copier',
  copied: 'Copié',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'Code',
  copy: 'Kopieren',
  copied: 'Kopiert',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'Код',
  copy: 'Копировать',
  copied: 'Скопировано',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'Código',
  copy: 'Copiar',
  copied: 'Copiado',
} satisfies Record<keyof typeof en, string>
