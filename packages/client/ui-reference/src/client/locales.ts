/** `reference` dictionaries for the unified `@` source and inline file navigation. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace owned by this plugin. */
export const NS = 'reference'

/** The reference namespace key union. */
export type ReferenceKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Reference menu and per-file navigation feedback. */
    reference: ReferenceKey
  }
}

/** English dictionary (the key-set source of truth). */
export const en = {
  'section.files': 'Files & folders',
  'section.subagents': 'Subagents',
  'section.sessions': 'Sessions',
  'candidate.noCwd': '(no cwd)',
  'crumb.root': 'Workspace',
  'fileOpen.title': 'Couldn’t open file',
  'fileOpen.failed': 'Couldn’t open “{path}”. Try again or close this message.',
  'fileOpen.close': 'Close',
  'fileOpen.retry': 'Retry',
  'time.now': 'now',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
} satisfies Record<string, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'section.files': 'ファイルとフォルダ',
  'section.subagents': 'サブエージェント',
  'section.sessions': 'セッション',
  'candidate.noCwd': '（cwdなし）',
  'crumb.root': 'ワークスペース',
  'fileOpen.title': 'ファイルを開けませんでした',
  'fileOpen.failed': '「{path}」を開けませんでした。再試行するか、このメッセージを閉じてください。',
  'fileOpen.close': '閉じる',
  'fileOpen.retry': '再試行',
  'time.now': '今',
  'time.minutes': '{n}分',
  'time.hours': '{n}時間',
  'time.days': '{n}日',
  'time.months': '{n}か月',
  'time.years': '{n}年',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'section.files': 'Archivos y carpetas',
  'section.subagents': 'Subagentes',
  'section.sessions': 'Sesiones',
  'candidate.noCwd': '(sin cwd)',
  'crumb.root': 'Espacio de trabajo',
  'fileOpen.title': 'No se pudo abrir el archivo',
  'fileOpen.failed': 'No se pudo abrir "{path}". Inténtalo de nuevo o cierra este mensaje.',
  'fileOpen.close': 'Cerrar',
  'fileOpen.retry': 'Reintentar',
  'time.now': 'ahora',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'section.files': 'Fichiers et dossiers',
  'section.subagents': 'Sous-agents',
  'section.sessions': 'Séances',
  'candidate.noCwd': '(pas de cwd)',
  'crumb.root': 'Espace de travail',
  'fileOpen.title': "Impossible d'ouvrir le fichier",
  'fileOpen.failed': "Impossible d'ouvrir \"{path}\". Réessayez ou fermez ce message.",
  'fileOpen.close': 'Fermer',
  'fileOpen.retry': 'Réessayer',
  'time.now': 'maintenant',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'section.files': 'Dateien und Ordner',
  'section.subagents': 'Subagenten',
  'section.sessions': 'Sitzungen',
  'candidate.noCwd': '(kein CWD)',
  'crumb.root': 'Arbeitsbereich',
  'fileOpen.title': 'Datei konnte nicht geöffnet werden',
  'fileOpen.failed': '„{path}“ konnte nicht geöffnet werden. Versuchen Sie es erneut oder schließen Sie diese Nachricht.',
  'fileOpen.close': 'Schließen',
  'fileOpen.retry': 'Erneut versuchen',
  'time.now': 'jetzt',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'section.files': 'Файлы и папки',
  'section.subagents': 'Субагенты',
  'section.sessions': 'Сессии',
  'candidate.noCwd': '(без КДВ)',
  'crumb.root': 'Рабочая область',
  'fileOpen.title': 'Не удалось открыть файл',
  'fileOpen.failed': 'Не удалось открыть «{path}». Попробуйте еще раз или закройте это сообщение.',
  'fileOpen.close': 'Закрыть',
  'fileOpen.retry': 'Повторить',
  'time.now': 'сейчас',
  'time.minutes': '{n}мин',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'section.files': 'Arquivos e pastas',
  'section.subagents': 'Subagentes',
  'section.sessions': 'Sessões',
  'candidate.noCwd': '(sem cwd)',
  'crumb.root': 'Espaço de trabalho',
  'fileOpen.title': 'Não foi possível abrir o arquivo',
  'fileOpen.failed': 'Não foi possível abrir “{path}”. Tente novamente ou feche esta mensagem.',
  'fileOpen.close': 'Fechar',
  'fileOpen.retry': 'Tentar novamente',
  'time.now': 'agora',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n} mês',
  'time.years': '{n}s',
} satisfies Record<keyof typeof en, string>
