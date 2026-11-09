/**
 * The Peer table: one Peer per member, live only while a header the edge signed for that member is unexpired.
 *
 * @module @mumbo/edge-member/src/members
 */

import type { PeerScope } from '@deepseek-ai/dsh-client-connection'

/** One member's Peer and the latest header expiry that keeps it live. */
interface MemberRecord {
  readonly peer: PeerScope
  /** Unix seconds; the Peer is disposed when this passes without a later header. */
  expiry: number
  timer: ReturnType<typeof setTimeout>
}

/** Live member Peers keyed by email; the owner disposes the table with its plugin. */
export class MemberPeers {
  private readonly records = new Map<string, MemberRecord>()

  /**
   * @param create - creates a Peer for one member; the plugin's Connection scope owns its lifetime.
   * @param nowMs - current time in milliseconds.
   */
  constructor(
    private readonly create: (email: string) => PeerScope,
    private readonly nowMs: () => number = Date.now,
  ) {}

  /**
   * The member's live Peer, kept live until at least `expiry`.
   *
   * A Peer whose last header expired is disposed, which ends every stream and socket it serves; the next
   * signed request creates a new Peer, and the client reconnects through the edge with a fresh header.
   * @param email - member the header names.
   * @param expiry - the header's expiry in Unix seconds.
   * @returns the member's Peer.
   */
  admit(email: string, expiry: number): PeerScope {
    const current = this.records.get(email)
    if (current !== undefined && !current.peer.signal.aborted) {
      if (expiry > current.expiry) {
        clearTimeout(current.timer)
        current.expiry = expiry
        current.timer = this.schedule(email, current.peer, expiry)
      }
      return current.peer
    }
    if (current !== undefined) clearTimeout(current.timer)
    const peer = this.create(email)
    this.records.set(email, { peer, expiry, timer: this.schedule(email, peer, expiry) })
    return peer
  }

  /** Cancel every expiry timer; the Peers themselves go with the Connection scope that created them. */
  clear(): void {
    for (const record of this.records.values()) clearTimeout(record.timer)
    this.records.clear()
  }

  private schedule(email: string, peer: PeerScope, expiry: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.records.get(email)?.peer !== peer) return
      this.records.delete(email)
      void peer.dispose()
    }, Math.max(0, expiry * 1000 - this.nowMs()))
    // An expiry timer must not keep the process alive on shutdown.
    timer.unref()
    return timer
  }
}
