/** Box link and view copy for every Client locale. */

/** Locale namespace of the box links and views. */
export const NS = 'boxLinks'

/** English copy. */
export const en = {
  'home': 'Home',
  'desktop': 'Desktop',
  'desktop.description': 'Your box\'s whole desktop',
  'browser': 'Browser',
  'browser.description': 'Chrome on your box',
  'browser.failed': 'Chrome could not be brought to the front: {detail}',
  'browser.retry': 'Try again',
  'view': 'Live view of your box desktop',
} satisfies Record<string, string>

/** Keys every box links dictionary defines. */
export type BoxLinksKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Box link labels and the Desktop and Browser tabs. */
    boxLinks: BoxLinksKey
  }
}

/** Japanese copy. */
export const ja = {
  'home': 'ホーム',
  'desktop': 'デスクトップ',
  'desktop.description': 'box のデスクトップ全体',
  'browser': 'ブラウザ',
  'browser.description': 'box の Chrome',
  'browser.failed': 'Chrome を前面に表示できませんでした: {detail}',
  'browser.retry': '再試行',
  'view': 'box デスクトップのライブビュー',
} satisfies Record<BoxLinksKey, string>
/** Spanish copy. */
export const es = {
  'home': 'Inicio',
  'desktop': 'Escritorio',
  'desktop.description': 'Todo el escritorio de tu box',
  'browser': 'Navegador',
  'browser.description': 'Chrome en tu box',
  'browser.failed': 'No se pudo traer Chrome al frente: {detail}',
  'browser.retry': 'Reintentar',
  'view': 'Vista en directo del escritorio de tu box',
} satisfies Record<BoxLinksKey, string>
/** French copy. */
export const fr = {
  'home': 'Accueil',
  'desktop': 'Bureau',
  'desktop.description': 'Tout le bureau de votre box',
  'browser': 'Navigateur',
  'browser.description': 'Chrome sur votre box',
  'browser.failed': 'Impossible de mettre Chrome au premier plan : {detail}',
  'browser.retry': 'Réessayer',
  'view': 'Vue en direct du bureau de votre box',
} satisfies Record<BoxLinksKey, string>
/** German copy. */
export const de = {
  'home': 'Startseite',
  'desktop': 'Desktop',
  'desktop.description': 'Der gesamte Desktop Ihrer Box',
  'browser': 'Browser',
  'browser.description': 'Chrome auf Ihrer Box',
  'browser.failed': 'Chrome konnte nicht in den Vordergrund geholt werden: {detail}',
  'browser.retry': 'Erneut versuchen',
  'view': 'Live-Ansicht des Desktops Ihrer Box',
} satisfies Record<BoxLinksKey, string>
/** Russian copy. */
export const ru = {
  'home': 'Главная',
  'desktop': 'Рабочий стол',
  'desktop.description': 'Весь рабочий стол вашего box',
  'browser': 'Браузер',
  'browser.description': 'Chrome на вашем box',
  'browser.failed': 'Не удалось вывести Chrome на передний план: {detail}',
  'browser.retry': 'Повторить',
  'view': 'Трансляция рабочего стола вашего box',
} satisfies Record<BoxLinksKey, string>
/** Portuguese copy. */
export const pt = {
  'home': 'Início',
  'desktop': 'Área de trabalho',
  'desktop.description': 'Toda a área de trabalho da sua box',
  'browser': 'Navegador',
  'browser.description': 'Chrome na sua box',
  'browser.failed': 'Não foi possível trazer o Chrome para a frente: {detail}',
  'browser.retry': 'Tentar novamente',
  'view': 'Visualização ao vivo da área de trabalho da sua box',
} satisfies Record<BoxLinksKey, string>
