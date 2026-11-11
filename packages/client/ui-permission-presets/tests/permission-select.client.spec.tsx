// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  PermissionCatalog, PermissionSelection,
} from '@deepseek-ai/dsh-permission-presets/client'
import {
  PermissionSelect, type PermissionSelectProps,
} from '../src/client/PermissionSelect.tsx'
import type { PermissionCatalogState } from '../src/client/catalog.ts'
import { accessEn } from '../src/client/locales.ts'

afterEach(cleanup)

const CATALOG: PermissionCatalog = {
  defaultPreset: 'read-only', defaultOptions: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }],
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
    {
      value: 'auto',
      name: 'Auto review',
      description: 'Host English Auto description',
    },
  ],
}

const t: PermissionSelectProps['t'] = makeTranslate(accessEn)

function setup(options: {
  selection?: PermissionSelection | undefined
  catalog?: PermissionCatalog | null
  locked?: boolean
  select?: (preset: string) => Promise<boolean>
} = {}) {
  const selection = createSnapshotStore<{ value: PermissionSelection | undefined }>({
    value: 'selection' in options ? options.selection : { currentValue: 'workspace-write' },
  })
  const catalog = createSnapshotStore<PermissionCatalogState>({
    value: options.catalog === undefined ? CATALOG : options.catalog,
  })
  const useProjection = (_key: string, selector?: (value: unknown) => unknown) =>
    bindSnapshotSelector(selection)(state => (selector ?? (value => value))(state.value))
  const select = vi.fn(options.select ?? (() => Promise.resolve(true)))
  const props = {
    locked: options.locked ?? false,
    useProjection,
    usePermissionCatalog: bindSnapshotSelector(catalog),
    select,
    t,
  } as unknown as PermissionSelectProps
  const view = render(<PermissionSelect {...props} />)
  return { catalog, props, select, selection, view }
}

function trigger(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^Access mode/ }) as HTMLButtonElement
}

describe('PermissionSelect', () => {
  it('renders only when both the Session selection and process catalog exist', () => {
    const missingSelection = setup({ selection: undefined })
    expect(missingSelection.view.container.innerHTML).toBe('')
    cleanup()
    const missingCatalog = setup({ catalog: null })
    expect(missingCatalog.view.container.innerHTML).toBe('')
  })

  it('renders process options and submits an ordinary choice optimistically', async () => {
    const submitted = Promise.withResolvers<boolean>()
    const { select } = setup({
      selection: { currentValue: 'read-only' },
      select: () => submitted.promise,
    })
    expect(trigger().textContent).toBe('Read Only')
    expect([...trigger().querySelectorAll('svg')]
      .every(icon => icon.closest('[aria-hidden="true"]') !== null)).toBe(true)

    fireEvent.click(trigger())
    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['Read Only', 'Workspace Write', 'Full access', 'Auto reviewEXP'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workspace Write' }))

    expect(select).toHaveBeenCalledExactlyOnceWith('workspace-write')
    expect(trigger().textContent).toBe('Workspace Write')
    expect(trigger().disabled).toBe(true)
    submitted.resolve(true)
    await act(async () => { await submitted.promise })
    expect(trigger().disabled).toBe(false)
  })

  it('preserves host labels and ignores the already-current row', () => {
    const catalog: PermissionCatalog = {
      defaultPreset: 'read-only', defaultOptions: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }],
      options: [
        { value: 'workspace-write', name: 'Project Files' },
        { value: 'danger-full-access', name: 'Operator Mode' },
        { value: 'custom-mode', name: 'custom-mode' },
        { value: '__proto__', name: '__proto__' },
      ],
    }
    const { select } = setup({ catalog })
    expect(trigger().textContent).toBe('Project Files')
    fireEvent.click(trigger())
    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['Project Files', 'Operator Mode', 'Custom Mode', '__proto__'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Project Files' }))
    expect(select).not.toHaveBeenCalled()
  })

  it('closes an open menu on an outside pointer', () => {
    setup()
    fireEvent.click(trigger())
    expect(screen.getAllByRole('menuitem')).toHaveLength(4)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('requires and resets explicit acknowledgement for Full access', async () => {
    const { select } = setup()
    const open = () => {
      fireEvent.click(trigger())
      fireEvent.click(screen.getByRole('menuitem', { name: 'Full access' }))
    }
    open()
    const enable = screen.getByRole<HTMLButtonElement>('button', { name: 'Enable Full access' })
    expect(enable.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand the risks and want to continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(select).not.toHaveBeenCalled()

    open()
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Enable Full access' }))
    expect(select).toHaveBeenCalledExactlyOnceWith('danger-full-access')
    await act(async () => {})
  })

  it('marks Auto experimental and uses the current-session risk copy', async () => {
    const { select, selection } = setup()
    fireEvent.click(trigger())
    const autoOption = screen.getByRole('menuitem', { name: 'Auto review EXP' })
    const autoGlyph = autoOption.querySelector('svg[aria-hidden="true"]')
    expect(autoGlyph).not.toBeNull()
    expect(autoGlyph!.innerHTML)
      .not.toBe(screen.getByRole('menuitem', { name: 'Full access' }).querySelector('svg')!.innerHTML)
    fireEvent.click(autoOption)

    const dialog = screen.getByRole('dialog', { name: 'Enable Auto review (experimental)?' })
    expect(dialog.textContent).toContain('runs without a sandbox')
    expect(dialog.textContent).toContain('can falsely allow or deny actions')
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand these risks and want to continue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enable Auto review' }))
    expect(select).toHaveBeenCalledExactlyOnceWith('auto')
    act(() => { selection.set({ value: { currentValue: 'auto' } }) })
    await act(async () => {})

    expect(trigger().getAttribute('aria-label')).toBe('Access mode, current: Auto review')
    expect(trigger().textContent).toBe('Auto review')
    expect(trigger().querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2)
    expect(trigger().getAttribute('title')).toBe('Run without a sandbox after an experimental same-model review of every native tool call and PTC inner call.')
  })

  it('explains Run Wild before switching to it, with the Full access glyph and its own description', async () => {
    const catalog = { ...CATALOG, options: [...CATALOG.options, { value: 'run-wild', name: 'run-wild' }] }
    const { select, selection } = setup({ catalog })
    fireEvent.click(trigger())
    const option = screen.getByRole('menuitem', { name: 'Run Wild' })
    expect(option.querySelector('svg')!.innerHTML)
      .toBe(screen.getByRole('menuitem', { name: 'Full access' }).querySelector('svg')!.innerHTML)
    fireEvent.click(option)

    const dialog = screen.getByRole('dialog', { name: 'Turn on Run Wild?' })
    expect(dialog.textContent).toContain('sends and posts as you, buys with saved payment methods, and deletes')
    expect(dialog.textContent).toContain('merges, deploys and repository access still need your approval')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(select).not.toHaveBeenCalled()

    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run Wild' }))
    const enable = screen.getByRole<HTMLButtonElement>('button', { name: 'Turn on Run Wild' })
    expect(enable.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand Mumbo will act without asking' }))
    fireEvent.click(enable)
    expect(select).toHaveBeenCalledExactlyOnceWith('run-wild')
    act(() => { selection.set({ value: { currentValue: 'run-wild' } }) })
    await act(async () => {})
    expect(trigger().textContent).toBe('Run Wild')
    expect(trigger().getAttribute('title')).toBe('Never asks: decides from context and your rules, acts, and logs what it did.')
  })

  it('revokes open UI when locked or either source disappears', () => {
    const locked = setup()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Full access' }))
    locked.view.rerender(<PermissionSelect {...locked.props} locked />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(trigger().disabled).toBe(true)

    cleanup()
    const vanished = setup()
    fireEvent.click(trigger())
    act(() => { vanished.catalog.set({ value: null }) })
    expect(vanished.view.container.innerHTML).toBe('')

    cleanup()
    const missingSelection = setup()
    fireEvent.click(trigger())
    act(() => { missingSelection.selection.set({ value: undefined }) })
    expect(missingSelection.view.container.innerHTML).toBe('')
  })

  it('revokes Auto confirmation and its optimistic label when the catalog withdraws it', async () => {
    const submitted = Promise.withResolvers<boolean>()
    const { catalog, select, selection } = setup({ select: () => submitted.promise })
    const withoutAuto = { ...CATALOG, options: CATALOG.options.filter(option => option.value !== 'auto') }
    const chooseAuto = () => {
      fireEvent.click(trigger())
      fireEvent.click(screen.getByRole('menuitem', { name: 'Auto review EXP' }))
    }
    try {
      chooseAuto()
      fireEvent.click(screen.getByRole('checkbox'))
      act(() => { catalog.set({ value: withoutAuto }) })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(select).not.toHaveBeenCalled()
      expect(trigger().disabled).toBe(false)

      act(() => { catalog.set({ value: CATALOG }) })
      expect(screen.queryByRole('dialog')).toBeNull()
      chooseAuto()
      expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
      fireEvent.click(screen.getByRole('checkbox'))
      fireEvent.click(screen.getByRole('button', { name: 'Enable Auto review' }))
      expect(select).toHaveBeenCalledExactlyOnceWith('auto')
      expect(trigger().textContent).toBe('Auto review')

      act(() => {
        selection.set({ value: { currentValue: 'danger-full-access' } })
        catalog.set({ value: withoutAuto })
      })
      expect(trigger().textContent).toBe('Full access')
      expect(trigger().disabled).toBe(true)
    } finally {
      submitted.resolve(false)
      await act(async () => { await submitted.promise })
    }
    expect(trigger().disabled).toBe(false)
  })

  it('falls back to an unknown current value and clears a rejected optimistic choice', async () => {
    const select = vi.fn(() => Promise.reject(new Error('rejected')))
    const { selection } = setup({ selection: { currentValue: 'custom' }, select })
    expect(trigger().textContent).toBe('Custom')
    expect(trigger().querySelectorAll('svg')).toHaveLength(1)

    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Workspace Write' }))
    expect(trigger().textContent).toBe('Workspace Write')
    await act(async () => {})
    expect(trigger().textContent).toBe('Custom')
    act(() => { selection.set({ value: { currentValue: 'workspace-write' } }) })
    expect(trigger().textContent).toBe('Workspace Write')
  })
})
