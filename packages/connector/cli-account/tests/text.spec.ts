/** A presenter writes each key in every language its dictionaries hold, with the values it passes filled in. */
import { expect, it } from 'vitest'
import { accountText } from '../src/text.ts'

const text = accountText({
  en: { status: 'Connected', signedIn: 'Signed in as {name} in {org}.' },
  fr: { status: 'Connecté', signedIn: 'Connecté en tant que {name} dans {org}.' },
})

it('renders a key in every language', () => {
  expect(text('status')).toEqual({ en: 'Connected', fr: 'Connecté' })
})

it('fills each placeholder with its value and leaves one without a value as written', () => {
  expect(text('signedIn', { name: 'Ada', org: 'Acme' })).toEqual({ en: 'Signed in as Ada in Acme.', fr: 'Connecté en tant que Ada dans Acme.' })
  expect(text('signedIn', { name: 'Ada' })).toEqual({ en: 'Signed in as Ada in {org}.', fr: 'Connecté en tant que Ada dans {org}.' })
})
