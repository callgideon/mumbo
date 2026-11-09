---
kind: upgrade-guide
description: "The Simplified Chinese (zh) language is removed from the Web client, the Desktop shell, and the Windows installer."
---

# Simplified Chinese UI language removed

## Change

The Web client, the Desktop shell, and the Windows installer no longer ship Simplified Chinese. The Language row in Settings offers English, Japanese, Spanish, French, German, Russian, and Portuguese. A stored or detected Chinese language raises no error; each surface falls back as follows.

- Web client: `zh` or `zh-CN` remains a valid `locale.preference` value in `$DSH_HOME/cordis.patch.yml`, and the value is kept, but it names no registered language. `LocaleRuntime` then shows the browser-derived language: the first browser language that matches a registered language exactly or by primary subtag, otherwise English (`detectBrowserLocale` and `FALLBACK_LOCALE` in [packages/client/locale/src/client/index.ts](../../../../packages/client/locale/src/client/index.ts)). A browser that lists only `zh-*` languages opens in English.
- Desktop shell (menus, dialogs, welcome and update windows): `resolveDesktopStartupLocale` in [apps/desktop/src/locale.ts](../../../../apps/desktop/src/locale.ts) skips a `zh` preference and every `zh-*` operating-system language, takes the next supported operating-system language, and otherwise uses English. `readDesktopLocaleCache` in [apps/desktop/src/locale-cache.ts](../../../../apps/desktop/src/locale-cache.ts) rejects a cached `zh-CN`, logs a warning, and starts in the system language. The DeepSeek platform sign-in view is always requested in `en_US`.
- Packaging: `apps/desktop/installer/locales/zh_CN.json` is deleted, so the Windows installer and uninstaller carry no Simplified Chinese strings; `en_US` is the first installer language ([apps/desktop/scripts/installer-locales.mjs](../../../../apps/desktop/scripts/installer-locales.mjs)). The macOS bundle no longer declares `zh_CN` in `CFBundleLocalizations`.
- Plugins: `ctx.locale.register` requires only the `en` dictionary. A `zh` dictionary or a `zh` key in localized package text still loads, but it is never displayed unless a plugin adds the `zh` language with `ctx.locale.addLanguage`.

## Migration

1. To replace a stored Chinese preference, choose a language in Settings > General > Language; the choice overwrites `locale.preference`. To follow the browser language instead, delete `locale.preference` from `$DSH_HOME/cordis.patch.yml`.
2. Desktop users need no other step: the next confirmed language overwrites `<userData>/desktop/locale-cache`.
3. Plugin authors may delete their `zh` dictionaries, `locale/zh.json` resources, and `zh` keys in localized package text; `en` is the only required dictionary.
4. Reload the Web UI or restart Desktop. Confirm that Settings shows the expected language and that the menus and dialogs use it.
