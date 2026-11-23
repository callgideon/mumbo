/** Copy for Remote's anonymous pages, before Client plugins load. */
export const loginLocales = {
  en: {
    pending: 'Signing in…',
    invalid: 'This QR code is invalid, expired, or already used. Generate a new code on a signed-in device, or use another sign-in method.',
    forbidden: 'QR sign-in is blocked for this address. Use another sign-in method, or ask the Host operator to check access settings.',
    unavailable: 'QR sign-in is unavailable. Use another sign-in method, or contact the Host operator.',
    failed: 'QR sign-in failed. Use another sign-in method, or generate a new QR code on a signed-in device.',
    networkFailed: 'Could not confirm QR sign-in. Check your connection and open the app to check, or use another sign-in method.',
    open: 'Open the app',
    authenticationTitle: 'Connect to this Host',
    authenticationDescription: 'Use one of the methods below to sign in.',
    authenticationUnavailable: 'No sign-in method is available. Contact the Host operator.',
    pairingScriptRequired: 'JavaScript is required to request device pairing.',
    tokenLabel: 'Enter a login token or link',
    tokenPlaceholder: '{url}?token=xxx',
    tokenPlaceholderFallbackUrl: 'http://<ip>:<port>/',
    tokenHint: 'On a signed-in device, copy the link from Settings → Remote connection and paste it here.',
    tokenInvalid: 'This login token is invalid or expired. Paste a current token and try again.',
    tokenFailed: 'Sign-in could not be confirmed. Try again or contact the Host operator.',
    tokenSubmit: 'Continue',
    tokenPending: 'Signing in…',
  },
}
