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
  'takeover.free': 'Mumbo can use this browser. Take over to sign in or type something private.',
  'takeover.held': 'You have the browser. Mumbo can\'t see or use it until you hand it back.',
  'takeover.unfinished': 'Mumbo can\'t use the browser, but taking over didn\'t finish: {detail}. Don\'t type anything private yet.',
  'takeover.take': 'Take over',
  'takeover.taking': 'Taking over…',
  'takeover.handBack': 'Hand back',
  'takeover.handing': 'Handing back…',
  'takeover.unknown': 'Couldn\'t check who has the browser: {detail}',
  'takeover.notHandedBack': 'Couldn\'t hand the browser back: {detail}',
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
  'takeover.free': 'Mumbo がこのブラウザを使えます。ログインや非公開の入力をするときは引き継いでください。',
  'takeover.held': 'ブラウザはあなたが操作中です。返すまで Mumbo は見ることも使うこともできません。',
  'takeover.unfinished': 'Mumbo はブラウザを使えませんが、引き継ぎが完了していません: {detail}。まだ非公開の内容を入力しないでください。',
  'takeover.take': '引き継ぐ',
  'takeover.taking': '引き継ぎ中…',
  'takeover.handBack': '返す',
  'takeover.handing': '返却中…',
  'takeover.unknown': 'ブラウザの操作者を確認できませんでした: {detail}',
  'takeover.notHandedBack': 'ブラウザを返せませんでした: {detail}',
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
  'takeover.free': 'Mumbo puede usar este navegador. Toma el control para iniciar sesión o escribir algo privado.',
  'takeover.held': 'Tienes el navegador. Mumbo no puede verlo ni usarlo hasta que lo devuelvas.',
  'takeover.unfinished': 'Mumbo no puede usar el navegador, pero la toma de control no terminó: {detail}. No escribas nada privado todavía.',
  'takeover.take': 'Tomar el control',
  'takeover.taking': 'Tomando el control…',
  'takeover.handBack': 'Devolver',
  'takeover.handing': 'Devolviendo…',
  'takeover.unknown': 'No se pudo comprobar quién tiene el navegador: {detail}',
  'takeover.notHandedBack': 'No se pudo devolver el navegador: {detail}',
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
  'takeover.free': 'Mumbo peut utiliser ce navigateur. Prenez la main pour vous connecter ou saisir quelque chose de privé.',
  'takeover.held': 'Vous avez le navigateur. Mumbo ne peut ni le voir ni l\'utiliser tant que vous ne le rendez pas.',
  'takeover.unfinished': 'Mumbo ne peut pas utiliser le navigateur, mais la prise en main n\'a pas abouti : {detail}. Ne saisissez encore rien de privé.',
  'takeover.take': 'Prendre la main',
  'takeover.taking': 'Prise en main…',
  'takeover.handBack': 'Rendre la main',
  'takeover.handing': 'Restitution…',
  'takeover.unknown': 'Impossible de vérifier qui a le navigateur : {detail}',
  'takeover.notHandedBack': 'Impossible de rendre le navigateur : {detail}',
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
  'takeover.free': 'Mumbo kann diesen Browser verwenden. Übernehmen Sie ihn, um sich anzumelden oder etwas Privates einzugeben.',
  'takeover.held': 'Sie haben den Browser. Mumbo kann ihn weder sehen noch verwenden, bis Sie ihn zurückgeben.',
  'takeover.unfinished': 'Mumbo kann den Browser nicht verwenden, aber die Übernahme wurde nicht abgeschlossen: {detail}. Geben Sie noch nichts Privates ein.',
  'takeover.take': 'Übernehmen',
  'takeover.taking': 'Wird übernommen…',
  'takeover.handBack': 'Zurückgeben',
  'takeover.handing': 'Wird zurückgegeben…',
  'takeover.unknown': 'Es konnte nicht geprüft werden, wer den Browser hat: {detail}',
  'takeover.notHandedBack': 'Der Browser konnte nicht zurückgegeben werden: {detail}',
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
  'takeover.free': 'Mumbo может пользоваться этим браузером. Возьмите управление, чтобы войти в аккаунт или ввести что-то личное.',
  'takeover.held': 'Браузер у вас. Mumbo не видит его и не может им пользоваться, пока вы его не вернёте.',
  'takeover.unfinished': 'Mumbo не может пользоваться браузером, но передача управления не завершилась: {detail}. Пока не вводите ничего личного.',
  'takeover.take': 'Взять управление',
  'takeover.taking': 'Берём управление…',
  'takeover.handBack': 'Вернуть',
  'takeover.handing': 'Возвращаем…',
  'takeover.unknown': 'Не удалось проверить, у кого браузер: {detail}',
  'takeover.notHandedBack': 'Не удалось вернуть браузер: {detail}',
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
  'takeover.free': 'O Mumbo pode usar este navegador. Assuma o controle para entrar numa conta ou digitar algo privado.',
  'takeover.held': 'O navegador está com você. O Mumbo não pode vê-lo nem usá-lo até que você o devolva.',
  'takeover.unfinished': 'O Mumbo não pode usar o navegador, mas a tomada de controle não terminou: {detail}. Não digite nada privado ainda.',
  'takeover.take': 'Assumir o controle',
  'takeover.taking': 'Assumindo o controle…',
  'takeover.handBack': 'Devolver',
  'takeover.handing': 'Devolvendo…',
  'takeover.unknown': 'Não foi possível verificar quem está com o navegador: {detail}',
  'takeover.notHandedBack': 'Não foi possível devolver o navegador: {detail}',
  'view': 'Visualização ao vivo da área de trabalho da sua box',
} satisfies Record<BoxLinksKey, string>
