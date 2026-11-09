import { Context } from '@deepseek-ai/cordis'
import { Peer, type PeerScope } from '@deepseek-ai/dsh-client-connection'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/index.ts'
import { MemberPeers } from '../src/members.ts'

const T0 = 1_800_000_000
const root = new Context()

/** A real Connection Peer for one member; its signal aborts once it is disposed. */
function fakePeer(email: string): PeerScope {
  return new Peer(root, { principal: { kind: 'edge-member', email } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0 * 1000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('member Peers', () => {
  it('serves one Peer per member until its latest header expires', async () => {
    const created: PeerScope[] = []
    const peers = new MemberPeers((email) => { const peer = fakePeer(email); created.push(peer); return peer })
    const ann = peers.admit('ann@example.com', T0 + 300)
    expect(peers.admit('ann@example.com', T0 + 200)).toBe(ann)
    expect(peers.admit('bo@example.com', T0 + 300)).not.toBe(ann)
    // A later header moves the expiry; an earlier one does not shorten it.
    expect(peers.admit('ann@example.com', T0 + 500)).toBe(ann)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(ann.signal.aborted).toBe(false)
    expect(created[1]?.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(200_000)
    expect(ann.signal.aborted).toBe(true)
  })

  it('creates a new Peer after the last one expired or was disposed elsewhere', async () => {
    const peers = new MemberPeers(fakePeer)
    const first = peers.admit('ann@example.com', T0 + 60)
    await vi.advanceTimersByTimeAsync(60_000)
    const second = peers.admit('ann@example.com', T0 + 400)
    expect(second).not.toBe(first)
    await second.dispose()
    const third = peers.admit('ann@example.com', T0 + 400)
    expect(third).not.toBe(second)
    expect(third.signal.aborted).toBe(false)
  })

  it('cancels every expiry timer on clear', async () => {
    const peers = new MemberPeers(fakePeer)
    const ann = peers.admit('ann@example.com', T0 + 60)
    peers.clear()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(ann.signal.aborted).toBe(false)
  })
})
