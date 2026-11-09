/** English labels for the same layout commands. */
export const en = { toggle: 'Toggle left sidebar' } satisfies Record<string, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'toggle': '左サイドバーを切り替え',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = { toggle: 'Alternar barra lateral izquierda' } satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = { toggle: 'Basculer la barre latérale gauche' } satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = { toggle: 'Linke Seitenleiste umschalten' } satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = { toggle: 'Переключить левую боковую панель' } satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = { toggle: 'Alternar barra lateral esquerda' } satisfies Record<keyof typeof en, string>
