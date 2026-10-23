/** Web account launcher for mumbo: the identity comes from the sign-in gate (oauth2-proxy), not the account platform. */
import { useEffect, useRef, useState } from 'react'
import { Menu, IconSettingsOutlineMedium, IconEllipsisOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountMenuProps } from './AccountMenu.tsx'
import { LogoutIcon } from './LogoutIcon.tsx'
import css from './AccountMenu.module.css'

interface GateIdentity { email: string; name: string | null; picture: string | null }

/**
 * Read the gate session's email, plus name and picture from the sign-in page's Supabase session when this origin holds it.
 * @returns the identity, or null when the page is not behind the gate.
 */
async function readIdentity(): Promise<GateIdentity | null> {
  const response = await fetch('/oauth2/userinfo', { credentials: 'same-origin' })
  if (!response.ok) return null
  const { email } = await response.json() as { email?: string }
  if (!email) return null
  let meta: Record<string, string | undefined> = {}
  try {
    const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k))
    const stored = key === undefined ? null : JSON.parse(localStorage.getItem(key) ?? 'null') as { user?: { email?: string; user_metadata?: typeof meta } } | null
    if (stored?.user?.email === email) meta = stored.user.user_metadata ?? {}
  } catch (_error) {
    // Storage may be blocked or hold another format; the email alone still identifies the account.
  }
  return { email, name: meta.full_name ?? meta.name ?? null, picture: meta.avatar_url ?? meta.picture ?? null }
}

/**
 * Sidebar launcher: the signed-in account with Settings and Sign out.
 * @param props - sidebar geometry, settings navigation and locale.
 * @returns account menu launcher.
 */
export function GateAccountMenu({ wide, settingsShortcut, openSettings, t }: AccountMenuProps) {
  const [identity, setIdentity] = useState<GateIdentity | null>(null)
  const [pictureFailed, setPictureFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let live = true
    readIdentity().then((value) => { if (live) setIdentity(value) }, () => undefined)
    return () => { live = false }
  }, [])
  const signedIn = identity !== null
  return <div className={css.root}>
    <Menu open={open} side="top" portal autoFocus className={css.anchor} listClassName={css.signedOutMenu}
      anchor={<button ref={trigger} type="button" className={css.trigger} data-collapsed={!wide} data-signed-out={!signedIn}
        aria-label={t('menu')} title={identity?.email} aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        {signedIn
          ? <span className={css.avatar}>
            {identity.picture !== null && !pictureFailed
              ? <img src={identity.picture} alt="" referrerPolicy="no-referrer" width={24} height={24}
                style={{ borderRadius: '50%' }} onError={() => { setPictureFailed(true) }} />
              : (identity.name ?? identity.email).charAt(0).toUpperCase()}
          </span>
          : <IconEllipsisOutlineMedium size={14} />}
        {wide && <span className={css.label}>{signedIn ? identity.name ?? identity.email : t('more')}</span>}
      </button>}
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} />,
          ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }) },
        ...(signedIn ? [{ id: 'signout', label: t('signOut'), icon: <LogoutIcon /> }] : []),
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'settings') { trigger.current?.focus(); openSettings() }
        // End the gate session, then let the sign-in page drop its Supabase session too.
        else location.assign(`/oauth2/sign_out?rd=${encodeURIComponent('/oauth/consent?signout=1')}`)
      }} />
  </div>
}
