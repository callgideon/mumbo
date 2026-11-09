// Push notifications to the founder's phone through ntfy (design section 5): the edge posts to a secret topic.

/**
 * Stub until the approval service needs it: sends nothing.
 * @param {{ topic: string | undefined, fetchImpl: typeof fetch }} deps
 * @returns {(message: { title: string, body: string, click: string }) => Promise<void>} sends one notification; `click` is the URL it opens.
 */
export function ntfy({ topic, fetchImpl }) {
  return async ({ title, body, click }) => {}
}
