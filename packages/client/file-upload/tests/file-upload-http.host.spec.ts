import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService, type ConnectionFetchAccessRequest } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Mock } from 'vitest'
import { handleFileUploadHttp } from '../src/http-route.ts'
import FileUploadsService, { type FileUploads } from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller shared by the access specs. */
    'test-guest': { readonly kind: 'test-guest'; readonly guest: string }
  }
}

function request(input: {
  method?: string
  sessionId?: string
  name?: string
  mediaType?: string
  contentType?: string
  body?: Uint8Array
} = {}): Request {
  const query = new URLSearchParams()
  if (input.sessionId !== undefined) query.set('sessionId', input.sessionId)
  if (input.name !== undefined) query.set('name', input.name)
  if (input.mediaType !== undefined) query.set('mediaType', input.mediaType)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return new Request(`http://host/api/session/uploadFileBinary${suffix}`, {
    method: input.method ?? 'POST',
    headers: input.contentType === undefined ? {} : { 'content-type': input.contentType },
    ...(input.body === undefined ? {} : { body: new Blob([Uint8Array.from(input.body).buffer]) }),
  })
}

function uploads(result: unknown): FileUploads & {
  uploadStream: Mock<FileUploads['uploadStream']>
  uploadedChunks: Uint8Array[]
} {
  const uploadedChunks: Uint8Array[] = []
  const uploadStream = vi.fn<FileUploads['uploadStream']>(async (input) => {
    for await (const chunk of input.data) uploadedChunks.push(chunk)
    return await result as Awaited<ReturnType<FileUploads['uploadStream']>>
  })
  return {
    uploadedChunks,
    uploadStream,
  } as unknown as FileUploads & {
    uploadStream: Mock<FileUploads['uploadStream']>
    uploadedChunks: Uint8Array[]
  }
}

describe('background file upload Fetch route', () => {
  it('accepts one authenticated streaming POST request', async () => {
    const service = uploads(Promise.resolve({}))
    expect((await handleFileUploadHttp(service, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).status).toBe(200)
  })

  it('rejects the wrong method, media type, and missing Session id without storing', async () => {
    const service = uploads(Promise.resolve({}))
    const wrongMethod = await handleFileUploadHttp(service, request({ method: 'GET' }))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const wrongType = await handleFileUploadHttp(service, request({ contentType: 'application/json' }))
    expect(wrongType.status).toBe(415)
    expect(await wrongType.text()).toBe('content type must be application/octet-stream')

    const missingSession = await handleFileUploadHttp(
      service,
      request({ contentType: 'application/octet-stream' }),
    )
    expect(missingSession.status).toBe(400)
    expect(await missingSession.text()).toBe('sessionId is required')
    expect(service.uploadStream).not.toHaveBeenCalled()
  })

  it('stores the request bytes and returns the staged receipt', async () => {
    const value = {
      receiptId: 'receipt-1',
      file: { attachmentId: 'file-1', name: 'large & final.bin', bytes: 4 },
    }
    const service = uploads(Promise.resolve(value))
    const response = await handleFileUploadHttp(service, request({
      sessionId: 's1',
      name: 'large & final.bin',
      contentType: 'application/octet-stream; charset=binary',
      body: Uint8Array.of(1, 2, 3, 4),
    }))
    expect(service.uploadStream).toHaveBeenCalledOnce()
    const upload = service.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1', name: 'large & final.bin' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(service.uploadedChunks).toEqual([Uint8Array.of(1, 2, 3, 4)])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('stages the body as a prompt image when the request names its media type', async () => {
    const value: Awaited<ReturnType<FileUploads['uploadImageStream']>> = {
      receiptId: 'receipt-2' as never,
      image: { attachmentId: 'image-1' as never, mediaType: 'image/png', bytes: 2, width: 1, height: 1 },
    }
    const imageChunks: Uint8Array[] = []
    const uploadImageStream = vi.fn<FileUploads['uploadImageStream']>(async (input) => {
      for await (const chunk of input.data) imageChunks.push(chunk)
      return value
    })
    const service = Object.assign(uploads(Promise.resolve({})), { uploadImageStream })
    const response = await handleFileUploadHttp(service, request({
      sessionId: 's1', name: 'shot.png', mediaType: 'image/png',
      contentType: 'application/octet-stream', body: Uint8Array.of(7, 8),
    }))
    expect(service.uploadStream).not.toHaveBeenCalled()
    expect(uploadImageStream.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's1', name: 'shot.png', mediaType: 'image/png' })
    expect(imageChunks).toEqual([Uint8Array.of(7, 8)])
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('returns business and internal storage failures and keeps an absent name absent', async () => {
    const business = uploads(Promise.reject(new RemoteError(
      'session/attachment-invalid', 'denied', { reason: 'NOPE' },
    )))
    const businessResponse = await handleFileUploadHttp(business, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))
    expect(business.uploadStream).toHaveBeenCalledOnce()
    const upload = business.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(business.uploadedChunks).toEqual([])
    expect(await businessResponse.json()).toEqual({
      ok: false,
      error: { code: 'session/attachment-invalid', message: 'denied', details: { reason: 'NOPE' } },
    })

    const internal = uploads(Promise.reject(new Error('disk offline')))
    expect(await (await handleFileUploadHttp(internal, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'disk offline', details: {} },
    })

    const foreignError = runInNewContext('new Error("disk exception")') as unknown as Error
    const exception = uploads(Promise.reject(foreignError))
    expect(await (await handleFileUploadHttp(exception, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'Error: disk exception', details: {} },
    })
  })
})

describe('background file upload route access', () => {
  function mount(saveFileStream: (input: { readonly data: AsyncIterable<Uint8Array>; readonly signal?: AbortSignal }) => Promise<unknown>) {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const agent = { id: 's1', session: { header: {} } }
    ctx.provide('agents', { get: (id: string) => id === agent.id ? agent : undefined } as never)
    ctx.provide('attachments', { saveFileStream, isAttachmentError: () => false } as never)
    ctx.provide('commands', { registerFileReceiptResolver: () => () => {} } as never)
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    new FileUploadsService(ctx)
    const decisions: ConnectionFetchAccessRequest[] = []
    connection.fetch.authorize((request) => {
      decisions.push(request)
      return request.resources.every(resource => resource.kind === 'session' && resource.id === 's1')
    })
    const shared = connection.createSharedFetchHandler('/api')
    const guest = connection.createPeer({ principal: { kind: 'test-guest', guest: 'file-upload' } })
    const post = (sessionId: string) => shared.fetch(request({
      sessionId, contentType: 'application/octet-stream', body: Uint8Array.of(1, 2, 3),
    }), guest)
    return { decisions, guest, post }
  }

  it('serves a non-owner only with fileUploads/uploadBinary on the Session the query names', async () => {
    const saveFileStream = vi.fn(async (input: { readonly data: AsyncIterable<Uint8Array> }) => {
      let bytes = 0
      for await (const chunk of input.data) bytes += chunk.byteLength
      return { attachmentId: 'file-1', name: 'file', bytes }
    })
    const { decisions, post } = mount(saveFileStream)

    const granted = await post('s1')
    expect(await granted.json()).toMatchObject({ ok: true, value: { file: { bytes: 3 } } })
    expect((await post('s2')).status).toBe(403)
    expect(saveFileStream).toHaveBeenCalledOnce()
    expect(decisions.map(({ action, resources }) => ({ action, resources }))).toEqual([
      { action: 'fileUploads/uploadBinary', resources: [{ kind: 'session', id: 's1' }] },
      { action: 'fileUploads/uploadBinary', resources: [{ kind: 'session', id: 's2' }] },
    ])
  })

  it('aborts a non-owner\'s running upload when its Peer is disposed', async () => {
    const started = Promise.withResolvers<AbortSignal>()
    const { guest, post } = mount(async (input) => {
      const signal = input.signal!
      started.resolve(signal)
      await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(new Error('upload aborted')) }, { once: true }) })
    })
    const running = post('s1')
    const signal = await started.promise
    await guest.dispose()
    expect(signal.aborted).toBe(true)
    expect(await (await running).json()).toMatchObject({ ok: false, error: { code: 'gateway/internal' } })
  })
})
