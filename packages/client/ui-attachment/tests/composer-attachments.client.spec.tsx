// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import type {
  ComposerAttachment, ComposerAttachmentsOwnerProps, ComposerAttachmentsProps,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ComposerAttachments } from '../src/client/ComposerAttachments.tsx'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const t = ((key: string, params?: Readonly<Record<string, unknown>>): string => {
  const messages: Record<string, string> = {
    'attachment.pending': 'Pending attachments',
    'attachment.scrollLeft': 'Scroll attachments left',
    'attachment.scrollRight': 'Scroll attachments right',
    'file.pending': 'Pending files',
    'file.uploading': 'Uploading…',
    'file.uploadFailed': 'Upload failed; click to retry',
    'file.label': 'File',
    'image.pending': 'Pending images',
    'image.original': 'Original image',
    'image.preview': 'Original image preview',
    'image.closePreview': 'Close original image preview',
    'image.openOriginal': 'View original',
    'attachment.dropBlocked': 'Files and images cannot be added right now',
    'attachment.dropTitle': 'Drag files or images here to add them',
  }
  if (key === 'file.remove') {
    const name = params?.name
    return `RemoveFile \${typeof name === 'string' ? name : ''}`
  }
  if (key === 'file.retry') {
    const name = params?.name
    return `Retry uploading \${typeof name === 'string' ? name : ''}`
  }
  if (key === 'image.remove') {
    const name = params?.name
    return `RemoveImage \${typeof name === 'string' ? name : ''}`
  }
  if (key === 'attachment.dropDesc') {
    const count = params?.count
    const size = params?.size
    return `Image limit: up to \${typeof count === 'number' ? String(count) : ''} images, \${typeof size === 'string' ? size : ''}`
  }
  return messages[key] ?? key
}) as ComposerAttachmentsProps['t']

function attachment(id: string, name = `${id}.png`): ComposerAttachment {
  return {
    kind: 'image',
    id: id as ComposerAttachment['id'],
    file: new File([Uint8Array.of(1)], name, { type: 'image/png' }),
    previewUrl: `blob:${id}`,
  }
}

function fileDraft(id: string, name = `${id}.pdf`): ComposerAttachment {
  return {
    kind: 'file',
    id: id as ComposerAttachment['id'],
    file: new File([Uint8Array.of(1, 2, 3)], name, { type: 'application/pdf' }),
  }
}

function props(overrides: Partial<ComposerAttachmentsOwnerProps> = {}): Parameters<typeof ComposerAttachments>[0] {
  return {
    attachments: [],
    canAcceptDrop: true,
    onAddFiles: () => {},
    onRemoveAttachment: () => {},
    uploads: {},
    onRetryFile: () => {},
    uploadFailureText: (reason: string) => `refused:${reason}`,
    t,
    ...overrides,
    readFileDrag: () => undefined,
  }
}

describe('ComposerAttachments', () => {
  it('accepts file drops anywhere on the document and keeps non-file drags native', () => {
    const onAddFiles = vi.fn()
    const view = render(<ComposerAttachments {...props({
      onAddFiles,
      dropLimits: { count: 20, size: '5MB' },
    })} />)

    expect(fireEvent.dragEnter(document.body, { dataTransfer: null })).toBe(true)
    const textTransfer = { types: ['text/plain'], files: [], dropEffect: 'none' }
    expect(fireEvent.dragEnter(document.body, { dataTransfer: textTransfer })).toBe(true)
    expect(fireEvent.dragOver(document.body, { dataTransfer: textTransfer })).toBe(true)
    expect(fireEvent.drop(document.body, { dataTransfer: textTransfer })).toBe(true)
    expect(view.queryByRole('status')).toBeNull()

    const image = attachment('dropped').file
    const dataTransfer = { types: ['Files'], files: [image], items: [], dropEffect: 'none' }
    expect(fireEvent.dragEnter(document.body, { dataTransfer })).toBe(false)
    expect(view.getByRole('status').textContent).toContain('Drag files or images here to add them')
    expect(view.getByRole('status').textContent).toContain('Image limit: up to 20 images, 5MB')
    expect(fireEvent.dragOver(document.body, { dataTransfer })).toBe(false)
    expect(dataTransfer.dropEffect).toBe('copy')
    expect(fireEvent.drop(document.body, { dataTransfer })).toBe(false)
    expect(onAddFiles).toHaveBeenCalledWith([image], new Set())
    expect(view.queryByRole('status')).toBeNull()
  })

  it('reports dropped directories from the entry API beside the dropped files', () => {
    const onAddFiles = vi.fn()
    render(<ComposerAttachments {...props({ onAddFiles })} />)
    const folder = new File([], 'project')
    const note = new File([Uint8Array.of(1)], 'notes.md', { type: 'text/markdown' })
    const entry = (isDirectory: boolean | null, file: File) => ({
      kind: 'file', getAsFile: () => new File([], file.name), webkitGetAsEntry: () => (isDirectory === null ? null : { isDirectory }),
    })
    fireEvent.drop(document.body, {
      dataTransfer: {
        types: ['Files'],
        files: [folder, note],
        items: [entry(true, folder), entry(false, note), { kind: 'string', getAsFile: () => null }],
        dropEffect: 'none',
      },
    })
    expect(onAddFiles).toHaveBeenCalledWith([folder, note], new Set([folder]))
    // An entry API that answers nothing, or a browser without it, reports no directories.
    fireEvent.drop(document.body, {
      dataTransfer: {
        types: ['Files'],
        files: [note],
        items: [entry(null, note), { kind: 'file', getAsFile: () => note }, entry(true, folder)],
        dropEffect: 'none',
      },
    })
    expect(onAddFiles).toHaveBeenLastCalledWith([note], new Set())
  })

  it('tracks nested file drags and clears an aborted drag', () => {
    const view = render(<ComposerAttachments {...props()} />)
    const dataTransfer = { types: ['Files'], files: [], items: [], dropEffect: 'none' }
    fireEvent.dragLeave(document.body, {
      dataTransfer: { types: ['text/plain'], files: [], dropEffect: 'none' },
    })
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragLeave(document.body, { dataTransfer, clientX: 5, clientY: 5 })
    expect(view.getByRole('status')).toBeTruthy()
    fireEvent.dragLeave(document.body, { dataTransfer, clientX: 5, clientY: 5 })
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.dragEnter(document.documentElement, { dataTransfer })
    const leftViewport = new Event('dragleave', { bubbles: true, cancelable: true })
    Object.defineProperties(leftViewport, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: -1 },
      clientY: { value: 5 },
    })
    fireEvent(document.documentElement, leftViewport)
    expect(view.queryByRole('status')).toBeNull()
    fireEvent.dragEnter(document.body, { dataTransfer })
    fireEvent.dragEnd(window, { dataTransfer })
    expect(view.queryByRole('status')).toBeNull()
  })

  it('shows a blocked drop without forwarding its files', () => {
    const onAddFiles = vi.fn()
    const view = render(<ComposerAttachments {...props({ canAcceptDrop: false, onAddFiles })} />)
    const image = attachment('blocked').file
    const dataTransfer = { types: ['Files'], files: [image], items: [], dropEffect: 'copy' }
    fireEvent.dragEnter(document.body, { dataTransfer })
    expect(view.getByRole('status').textContent).toBe('Files and images cannot be added right now')
    fireEvent.dragOver(document.body, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('none')
    fireEvent.drop(document.body, { dataTransfer })
    expect(onAddFiles).not.toHaveBeenCalled()
    expect(view.queryByRole('status')).toBeNull()
  })

  it('routes rail removal and closes previews on Escape or attachment removal', () => {
    const onRemoveAttachment = vi.fn()
    const image = attachment('draft-1', 'pixel.png')
    const initial = props({ attachments: [image], onRemoveAttachment })
    const view = render(<ComposerAttachments {...initial} />)

    fireEvent.click(view.getByRole('button', { name: 'RemoveImage pixel.png' }))
    expect(onRemoveAttachment).toHaveBeenCalledWith(image.id)
    fireEvent.click(view.getByTitle('View original'))
    expect(view.getByRole('dialog', { name: 'Original image preview' })).toBeTruthy()
    view.rerender(<ComposerAttachments {...props({ attachments: [], onRemoveAttachment })} />)
    expect(view.queryByRole('dialog', { name: 'Original image preview' })).toBeNull()

    view.rerender(<ComposerAttachments {...initial} />)
    fireEvent.click(view.getByTitle('View original'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(view.queryByRole('dialog', { name: 'Original image preview' })).toBeNull()
  })

  it('keeps images and files in pick order inside one attachment rail', () => {
    const view = render(<ComposerAttachments {...props({
      attachments: [attachment('first'), fileDraft('middle'), attachment('last')],
      uploads: {
        middle: {
          status: 'ready', receiptId: 'receipt-middle' as never,
          file: { attachmentId: 'file-middle' as never, name: 'middle.pdf', bytes: 3 },
        },
      },
    })} />)
    const rail = view.getByRole('group', { name: 'Pending attachments' })
    expect([...rail.children].map((child) => {
      const image = child.querySelector('img')
      return image?.getAttribute('alt') ?? child.querySelector('[title]')?.getAttribute('title')
    })).toEqual(['first.png', 'middle.pdf', 'last.png'])
    expect(view.queryByRole('group', { name: 'Pending files' })).toBeNull()
  })

  it('labels an unnamed attachment and its original-image preview', () => {
    const image = attachment('unnamed', '')
    const view = render(<ComposerAttachments {...props({ attachments: [image] })} />)
    expect(view.getByAltText('Pending images')).toBeTruthy()
    fireEvent.click(view.getByTitle('View original'))
    expect(view.getByAltText('Original image')).toBeTruthy()
  })
})

describe('ComposerAttachments image uploads', () => {
  it('shows image upload progress, retries a failed image, and explains one the Host refused', () => {
    const onRetryFile = vi.fn()
    const view = render(<ComposerAttachments {...props({
      attachments: [
        attachment('measured'), attachment('streaming'), attachment('failed'), attachment('refused'), attachment('ready'),
      ],
      uploads: {
        measured: { status: 'uploading', loaded: 1, total: 2 },
        streaming: { status: 'uploading', loaded: 3 },
        failed: { status: 'error', message: 'boom' },
        refused: { status: 'error', message: 'too wide', reason: 'IMAGE_DIMENSION_TOO_LARGE' },
        ready: { status: 'ready', receiptId: 'receipt-ready' as never },
      },
      onRetryFile,
    })} />)
    expect(view.container.querySelector('[style="width: 50%;"]')).toBeTruthy()
    expect(view.getAllByTitle('View original').map(button => button.getAttribute('aria-busy')))
      .toEqual(['true', 'true', 'false'])
    fireEvent.click(view.getByRole('button', { name: 'Retry uploading failed.png' }))
    expect(onRetryFile).toHaveBeenCalledWith('failed')
    // A refusal names its reason and offers neither retry nor preview; removal stays available.
    fireEvent.click(view.getByRole('button', { name: 'refused:IMAGE_DIMENSION_TOO_LARGE' }))
    expect(onRetryFile).toHaveBeenCalledTimes(1)
    expect(view.queryByRole('button', { name: 'Retry uploading refused.png' })).toBeNull()
    expect(view.getByRole('button', { name: 'RemoveImage refused.png' })).toBeTruthy()
    expect(view.queryByRole('dialog', { name: 'Original image preview' })).toBeNull()
  })

  it('explains a failed image on hover and pins a refusal on tap', () => {
    vi.useFakeTimers()
    try {
      const view = render(<ComposerAttachments {...props({
        attachments: [attachment('failed'), attachment('refused')],
        uploads: {
          failed: { status: 'error', message: 'boom' },
          refused: { status: 'error', message: 'too wide', reason: 'IMAGE_DIMENSION_TOO_LARGE' },
        },
      })} />)
      // The stubbed ResizeObserver never measures, so the bubble mounts unplaced and hidden.
      const bubble = () => view.queryByRole('tooltip', { hidden: true })
      const retry = view.getByRole('button', { name: 'Retry uploading failed.png' })
      fireEvent.pointerEnter(retry)
      expect(bubble()).toBeNull()
      act(() => { vi.advanceTimersByTime(300) })
      expect(bubble()?.textContent).toBe('Upload failed; click to retry')
      fireEvent.pointerLeave(retry)
      expect(bubble()).toBeNull()

      const refused = view.getByRole('button', { name: 'refused:IMAGE_DIMENSION_TOO_LARGE' })
      fireEvent.click(refused)
      expect(bubble()?.textContent).toBe('refused:IMAGE_DIMENSION_TOO_LARGE')
      expect(refused.getAttribute('aria-describedby')).toBe(bubble()?.id)
      fireEvent.pointerLeave(refused)
      expect(bubble()?.textContent).toBe('refused:IMAGE_DIMENSION_TOO_LARGE')
    } finally {
      vi.useRealTimers()
    }
  })

  it('names an image without a file name in its preview, retry, and remove controls', () => {
    const view = render(<ComposerAttachments {...props({
      attachments: [attachment('pasted', ''), attachment('shown', '')],
      uploads: { pasted: { status: 'error', message: 'boom' } },
    })} />)
    expect(view.getByRole('button', { name: 'Retry uploading Pending images' })).toBeTruthy()
    expect(view.getAllByRole('button', { name: 'RemoveImage Pending images' })).toHaveLength(2)
    expect(view.getByAltText('Pending images')).toBeTruthy()
  })
})

describe('ComposerAttachments file drafts', () => {
  it('renders uploading, ready, and failed cards with remove and retry affordances', () => {
    const onRemoveAttachment = vi.fn()
    const onRetryFile = vi.fn()
    const view = render(<ComposerAttachments {...props({
      attachments: [fileDraft('up'), fileDraft('ok'), fileDraft('bad')],
      uploads: {
        up: { status: 'uploading', loaded: 1, total: 4 },
        ok: {
          status: 'ready', receiptId: 'receipt-ok' as never,
          file: { attachmentId: 'file-ok' as never, name: 'ok.pdf', bytes: 3 },
        },
        bad: { status: 'error', message: 'boom' },
      },
      onRemoveAttachment,
      onRetryFile,
    })} />)
    const group = view.getByRole('group', { name: 'Pending attachments' })
    expect(group.textContent).toContain('Uploading…')
    expect(view.container.querySelector('[style="width: 25%;"]')).toBeTruthy()
    expect(group.textContent).toContain('ok.pdf')
    expect(group.textContent).toContain('PDF 3B')
    expect(group.textContent).toContain('Upload failed; click to retry')
    fireEvent.click(view.getByRole('button', { name: 'Retry uploading bad.pdf' }))
    expect(onRetryFile).toHaveBeenCalledWith('bad')
    fireEvent.click(view.getByRole('button', { name: 'RemoveFile ok.pdf' }))
    expect(onRemoveAttachment).toHaveBeenCalledWith('ok')
  })

  it('treats a draft without upload state as uploading and keeps retry separate from remove', () => {
    const onRetryFile = vi.fn()
    const onRemoveAttachment = vi.fn()
    const view = render(<ComposerAttachments {...props({
      attachments: [fileDraft('pending'), fileDraft('bad')],
      uploads: { bad: { status: 'error', message: 'boom' } },
      onRetryFile,
      onRemoveAttachment,
    })} />)
    expect(view.getByRole('group', { name: 'Pending attachments' }).textContent).toContain('Uploading…')
    const retry = view.getByRole('button', { name: 'Retry uploading bad.pdf' })
    const remove = view.getByRole('button', { name: 'RemoveFile bad.pdf' })
    expect(retry.contains(remove)).toBe(false)
    fireEvent.click(remove)
    expect(onRemoveAttachment).toHaveBeenCalledWith('bad')
    expect(onRetryFile).not.toHaveBeenCalled()
    fireEvent.click(retry)
    expect(onRetryFile).toHaveBeenCalledWith('bad')
  })

  it('uses the localized file label when the browser supplies no name', () => {
    const view = render(<ComposerAttachments {...props({
      attachments: [fileDraft('unnamed', '')],
      uploads: {
        unnamed: {
          status: 'ready', receiptId: 'receipt-unnamed' as never,
          file: { attachmentId: 'file-unnamed' as never, name: 'file', bytes: 3 },
        },
      },
    })} />)
    const group = view.getByRole('group', { name: 'Pending attachments' })
    expect(group.textContent).toContain('File')
    expect(group.textContent).toContain('3B')
  })

  it('uses the shared leading-dot suffix in ready-file metadata', () => {
    const view = render(<ComposerAttachments {...props({
      attachments: [fileDraft('env', '.env')],
      uploads: {
        env: {
          status: 'ready', receiptId: 'receipt-env' as never,
          file: { attachmentId: 'file-env' as never, name: '.env', bytes: 3 },
        },
      },
    })} />)
    expect(view.getByTitle('.env').textContent).toContain('ENV 3B')
  })
})

it('accepts internal file tokens only inside the composer without the full-page overlay', () => {
  const file = new File([Uint8Array.of(1, 2)], 'original.pdf', { type: 'application/pdf' })
  const onAddFiles = vi.fn()
  const view = render(<div data-composer-card data-testid="composer"><ComposerAttachments {...props({ onAddFiles })}
    readFileDrag={transfer => transfer.getData('application/x-dsh-file') === 'token' ? file : undefined} /></div>)
  const data = new Map([['application/x-dsh-file', 'token']])
  const transfer = {
    types: ['application/x-dsh-file'], items: [], files: [],
    getData: (key: string) => data.get(key) ?? '',
  }
  fireEvent.dragEnter(document.body, { dataTransfer: transfer })
  fireEvent.dragOver(document.body, { dataTransfer: transfer })
  fireEvent.drop(document.body, { dataTransfer: transfer })
  expect(onAddFiles).not.toHaveBeenCalled()
  const target = view.getByTestId('composer')
  fireEvent.dragEnter(target, { dataTransfer: transfer })
  fireEvent.dragOver(target, { dataTransfer: transfer })
  expect(view.queryByText('Drag files or images here to add them')).toBeNull()
  fireEvent.drop(target, { dataTransfer: transfer })
  expect(onAddFiles).toHaveBeenCalledExactlyOnceWith([file], new Set())
  data.set('application/x-dsh-file', 'foreign')
  fireEvent.drop(target, { dataTransfer: transfer })
  expect(onAddFiles).toHaveBeenCalledOnce()
})
