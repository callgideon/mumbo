/** Anonymous pairing copy available before the application locale service. */

const en = {
  pairTitle: 'Pair this device',
  pairHint: 'After requesting, open Settings → Remote connection on another signed-in device. Match the pairing code and approve to sign in here automatically.',
  pairCreating: 'Requesting approval…',
  pairWaiting: 'Waiting for approval…',
  pairCancelling: 'Cancelling this request…',
  pairReplacing: 'Cancelling the previous request before requesting again…',
  pairChecking: 'Checking sign-in status…',
  pairRecovering: 'Reconnecting automatically…',
  pairRateLimited: 'Too many requests. Retrying shortly…',
  pairRateLimitError: 'Too many requests. Wait a moment, then request again.',
  pairCheckError: 'Could not confirm sign-in. Check your connection, then request again.',
  pairCode: 'Pairing code',
  pairRemaining: 'Expires in {time}',
  pairDenied: 'The request was denied. You can request again.',
  pairExpired: 'The request expired. Request again.',
  pairError: 'Could not complete pairing. Check your connection, then request again.',
  pairCreateError: 'Could not request pairing. Check your connection, then request again.',
  pairCancel: 'Cancel request',
  pairAgain: 'Request again',
} as const

/** Stable keys shared by the anonymous pairing translations. */
export type PairingLocaleKey = keyof typeof en

/** Public dictionaries embedded in the anonymous script before application startup. */
export const pairingLocales = { en }

/** Labels for the anonymous method and its initial request action. */
export const pairingMethodLabels: Readonly<Record<string, string> & { en: string }> = {
  en: 'Request to pair', de: 'Kopplung anfordern', es: 'Solicitar vinculación',
  fr: 'Demander l’association', ja: 'ペアリングを申請', pt: 'Solicitar pareamento', ru: 'Запросить сопряжение',
}
