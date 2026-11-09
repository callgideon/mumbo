/** Box link labels for every Client locale. */

/** Locale namespace of the box links. */
export const NS = 'boxLinks'

/** English labels. */
export const en = {
  home: 'Home',
  desktop: 'Desktop',
} satisfies Record<string, string>

/** Keys every box link dictionary defines. */
export type BoxLinksKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Box link labels. */
    boxLinks: BoxLinksKey
  }
}

/** Simplified Chinese labels. */
export const zh = { home: '主页', desktop: '桌面' } satisfies Record<BoxLinksKey, string>
/** Japanese labels. */
export const ja = { home: 'ホーム', desktop: 'デスクトップ' } satisfies Record<BoxLinksKey, string>
/** Spanish labels. */
export const es = { home: 'Inicio', desktop: 'Escritorio' } satisfies Record<BoxLinksKey, string>
/** French labels. */
export const fr = { home: 'Accueil', desktop: 'Bureau' } satisfies Record<BoxLinksKey, string>
/** German labels. */
export const de = { home: 'Startseite', desktop: 'Desktop' } satisfies Record<BoxLinksKey, string>
/** Russian labels. */
export const ru = { home: 'Главная', desktop: 'Рабочий стол' } satisfies Record<BoxLinksKey, string>
/** Portuguese labels. */
export const pt = { home: 'Início', desktop: 'Área de trabalho' } satisfies Record<BoxLinksKey, string>
