// The browser plugin's inventory surfaces follow access to the inventory: the panel and every read
// exist only while the page may call `dynamicCordisRunner/inventory`.

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { StaticRemoteAccess } from '@deepseek-ai/dsh-client-test-runtime'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'

async function bench(allows: (action: string) => boolean = () => true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  new StaticRemoteAccess(ctx, allows)
  const inventory = vi.fn(() => Promise.resolve({ ok: true as const, value: [] }))
  const namespace = { inventory, stopFromPanel: vi.fn(), undefineFromPanel: vi.fn() }
  ctx.reflect.provide('remote', { dynamicCordisRunner: namespace, $on: () => () => {} })
  ctx.reflect.provide('remote.dynamicCordisRunner', namespace)
  ctx.reflect.provide('dynamicCordisRunner', {
    getSnapshot: () => [],
    subscribe: () => () => {},
    reconcileApprovals: vi.fn(),
  })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  return { ctx, slots, inventory }
}

describe('ui-cordis browser plugin', () => {
  it('reads the inventory and offers the panel while the page may read the inventory', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.inventory).toHaveBeenCalledTimes(1)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
  })

  it('reads nothing and offers no panel, keeping the tool cards, on a page that may not read the inventory', async () => {
    const allows = vi.fn((action: string) => action !== 'dynamicCordisRunner/inventory')
    const b = await bench(allows)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    b.ctx.emit('connection/reset')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(allows).toHaveBeenCalledWith('dynamicCordisRunner/inventory')
    expect(b.inventory).not.toHaveBeenCalled()
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
    expect(b.slots.entries('tool.call.toolview').map(entry => entry.options.key)).toEqual(
      expect.arrayContaining(['cordis_define', 'cordis_run']),
    )
  })
})
