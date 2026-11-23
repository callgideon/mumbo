/** External panel using only its declared Slot props and shared React module. */
window.__ModuleLoader__.load({
  id: '@fixture/remote-connection',
  factory(require) {
    const { createElement: h } = require('react')
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('fixtureRemoteConnection', {
          en: {
            title: 'Custom remote connection', invitation: 'Invitation ID', phase: 'Invitation state',
            create: 'Create invitation', cancel: 'Cancel invitation', reload: 'Reload', close: 'Close settings',
          },
        }))
        ctx.slots.inject('settings.remoteConnection.content', () => ctx.slots.register({
          name: 'settings.remoteConnection.content', priority: -1, locale: 'fixtureRemoteConnection',
        }, ({ t, useRemoteConnection, create, cancel, reload, close }) => {
          const { deployment, phase, ticket } = useRemoteConnection(state => state)
          const busy = phase === 'creating' || phase === 'cancelling'
          return h('section', { 'aria-label': t('title') },
            h('h2', null, t('title')),
            deployment === null ? null : h('code', null, deployment.url),
            h('p', { role: 'status' }, `${t('phase')}: ${phase}`),
            h('output', { 'aria-label': t('invitation') }, ticket?.id ?? ''),
            h('button', { type: 'button', disabled: busy, onClick: create }, t('create')),
            h('button', { type: 'button', disabled: busy || ticket === null, onClick: cancel }, t('cancel')),
            h('button', { type: 'button', disabled: busy, onClick: reload }, t('reload')),
            h('button', { type: 'button', onClick: close }, t('close')),
          )
        }))
      },
    }
  },
})
