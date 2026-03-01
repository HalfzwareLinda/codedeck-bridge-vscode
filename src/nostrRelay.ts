/**
 * Nostr relay transport for Codedeck Bridge.
 *
 * Protocol:
 * - Session list: NIP-33 replaceable events (kind 30515, d-tag = machine name).
 *   Relays keep only the latest version, so phones always get current session list.
 * - Output: Regular events (kind 29515) with seq counter per session.
 *   Stored by relays, enabling catch-up when phone reconnects.
 * - History: Bridge sends history-response events when phone requests catch-up.
 *
 * All messages are NIP-44 encrypted between bridge and phone keypairs.
 */

import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey, generateSecretKey } from 'nostr-tools/pure';
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import type {
  BridgeOutbound,
  BridgeInbound,
  PairedPhone,
  OutputEntry,
  RemoteSessionInfo,
} from './types';
import { SESSION_LIST_EVENT_KIND, OUTPUT_EVENT_KIND } from './types';

export interface NostrRelayEvents {
  onInput: (sessionId: string, text: string) => void;
  onPermissionResponse: (sessionId: string, requestId: string, allow: boolean) => void;
  onModeChange: (sessionId: string, mode: 'plan' | 'auto') => void;
  onHistoryRequest: (sessionId: string, afterSeq: number | undefined, phonePubkey: string) => void;
  onCreateSession: () => void;
}

export class NostrRelay {
  private pool: SimplePool | null = null;
  private secretKey: Uint8Array;
  private pubkeyHex: string;
  private relays: string[];
  private pairedPhones: PairedPhone[];
  private events: NostrRelayEvents;
  private subscription: ReturnType<SimplePool['subscribeMany']> | null = null;
  private machineName: string;
  private onConnectionChange?: (status: 'connected' | 'disconnected' | 'error', message?: string) => void;
  private reconnecting = false;

  constructor(
    secretKey: Uint8Array,
    relays: string[],
    pairedPhones: PairedPhone[],
    machineName: string,
    events: NostrRelayEvents,
  ) {
    this.secretKey = secretKey;
    this.pubkeyHex = getPublicKey(secretKey);
    this.relays = relays;
    this.pairedPhones = pairedPhones;
    this.events = events;
    this.machineName = machineName;
  }

  get npub(): string {
    return nip19.npubEncode(this.pubkeyHex);
  }

  get pubkey(): string {
    return this.pubkeyHex;
  }

  setConnectionCallback(cb: (status: 'connected' | 'disconnected' | 'error', message?: string) => void): void {
    this.onConnectionChange = cb;
  }

  connect(): void {
    this.reconnecting = true;
    this.disconnect();
    this.reconnecting = false;

    this.pool = new SimplePool();

    // Subscribe to events tagged to our pubkey from paired phones
    const phonePubkeys = this.pairedPhones.map(p => p.pubkeyHex);
    if (phonePubkeys.length === 0) {
      console.log('[Codedeck] No paired phones, skipping subscription');
      this.onConnectionChange?.('disconnected', 'No paired phones');
      return;
    }

    try {
      this.subscription = this.pool.subscribeMany(
        this.relays,
        // Listen for both output-kind and session-list-kind events from phones.
        // `since` prevents replaying historical create-session/input events on reconnect.
        // Session list (kind 30515) is not affected — the bridge publishes its own on connect.
        {
          kinds: [OUTPUT_EVENT_KIND, SESSION_LIST_EVENT_KIND],
          '#p': [this.pubkeyHex],
          authors: phonePubkeys,
          since: Math.floor(Date.now() / 1000) - 5, // only events from now (5s grace)
        },
        {
          onevent: (event) => {
            this.handleIncomingEvent(event);
          },
          oneose: () => {
            console.log('[Codedeck] Connected to relays, subscription active');
            this.onConnectionChange?.('connected');
          },
        },
      );
    } catch (err) {
      console.error('[Codedeck] Failed to connect to relays:', err);
      this.onConnectionChange?.('error', String(err));
    }
  }

  disconnect(): void {
    const wasConnected = this.isConnected();
    if (this.subscription) {
      this.subscription.close();
      this.subscription = null;
    }
    if (this.pool) {
      this.pool.destroy();
      this.pool = null;
    }
    if (wasConnected && !this.reconnecting) {
      this.onConnectionChange?.('disconnected');
    }
  }

  isConnected(): boolean {
    return this.pool !== null && this.subscription !== null;
  }

  updateRelays(relays: string[]): void {
    this.relays = relays;
    if (this.isConnected()) {
      this.connect(); // Reconnect with new relays
    }
  }

  updatePairedPhones(phones: PairedPhone[]): void {
    this.pairedPhones = phones;
    if (this.isConnected()) {
      this.connect(); // Reconnect with updated authors filter
    }
  }

  /**
   * Publish session list as a NIP-33 replaceable event.
   * Kind 30515 with d-tag = machine name ensures relays keep only the latest.
   */
  async publishSessionList(sessions: RemoteSessionInfo[]): Promise<void> {
    if (!this.pool || this.pairedPhones.length === 0) {
      console.log(`[Codedeck] publishSessionList skipped: pool=${!!this.pool}, phones=${this.pairedPhones.length}`);
      return;
    }
    console.log(`[Codedeck] publishSessionList: ${sessions.length} sessions to ${this.pairedPhones.length} phones via ${this.relays.join(', ')}`);

    const msg: BridgeOutbound = {
      type: 'sessions',
      machine: this.machineName,
      sessions,
    };

    const json = JSON.stringify(msg);

    for (const phone of this.pairedPhones) {
      if (!this.pool) { return; }
      try {
        const conversationKey = getConversationKey(this.secretKey, phone.pubkeyHex);
        const ciphertext = encrypt(json, conversationKey);

        const event = finalizeEvent({
          kind: SESSION_LIST_EVENT_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['p', phone.pubkeyHex],
            ['d', this.machineName], // NIP-33: identifier for replaceable event
          ],
          content: ciphertext,
        }, this.secretKey);

        console.log(`[Codedeck] Publishing session list event: kind=${event.kind}, content=${ciphertext.length} chars, to ${phone.label} (${phone.pubkeyHex.slice(0, 8)}...)`);
        const results = this.pool.publish(this.relays, event);
        for (let i = 0; i < results.length; i++) {
          results[i]
            .then((res: unknown) => console.log(`[Codedeck] Relay ${this.relays[i]}: publish OK`, res))
            .catch((err: unknown) => console.error(`[Codedeck] Relay ${this.relays[i]}: publish FAILED`, err));
        }
      } catch (err) {
        console.error(`[Codedeck] Failed to publish session list to ${phone.label}:`, err);
      }
    }
  }

  /**
   * Publish output entries as regular events with seq counter.
   * Regular kind 29515 events are stored by relays for catch-up.
   */
  async publishOutput(sessionId: string, entries: Array<{ seq: number; entry: OutputEntry }>): Promise<void> {
    if (!this.pool || this.pairedPhones.length === 0) { return; }

    for (const { seq, entry } of entries) {
      const msg: BridgeOutbound = {
        type: 'output',
        sessionId,
        seq,
        entry,
      };

      const json = JSON.stringify(msg);

      for (const phone of this.pairedPhones) {
        if (!this.pool) { return; }
        try {
          const conversationKey = getConversationKey(this.secretKey, phone.pubkeyHex);
          const ciphertext = encrypt(json, conversationKey);

          const event = finalizeEvent({
            kind: OUTPUT_EVENT_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ['p', phone.pubkeyHex],
              ['s', sessionId],   // session tag for filtering
              ['seq', String(seq)], // sequence number for ordering
            ],
            content: ciphertext,
          }, this.secretKey);

          const results = this.pool.publish(this.relays, event);
          for (let i = 0; i < results.length; i++) {
            results[i].catch((err: unknown) => {
              const msg2 = err instanceof Error ? err.message : String(err);
              console.warn(`[Codedeck] Relay ${this.relays[i]}: output publish failed: ${msg2}`);
            });
          }
        } catch (err) {
          console.error(`[Codedeck] Failed to publish output to ${phone.label}:`, err);
        }
      }
    }
  }

  private static readonly HISTORY_CHUNK_SIZE = 20;
  private static readonly MAX_CHUNK_JSON_BYTES = 48_000;
  private static readonly CHUNK_DELAY_MS = 500;

  /**
   * Send history response to a specific phone, chunked into multiple events
   * to stay within relay message size limits.
   */
  async publishHistory(
    phonePubkey: string,
    sessionId: string,
    entries: Array<{ seq: number; entry: OutputEntry }>,
    totalEntries: number,
  ): Promise<void> {
    if (!this.pool) { return; }

    const requestId = crypto.randomUUID();
    const chunks = this.splitIntoChunks(entries);
    const totalChunks = chunks.length;

    console.log(`[Codedeck] publishHistory: ${entries.length} entries in ${totalChunks} chunks for session ${sessionId}`);

    for (let i = 0; i < chunks.length; i++) {
      if (!this.pool) { return; }

      const chunk = chunks[i];
      const fromSeq = chunk.length > 0 ? chunk[0].seq : 0;
      const toSeq = chunk.length > 0 ? chunk[chunk.length - 1].seq : 0;

      const msg: BridgeOutbound = {
        type: 'history',
        sessionId,
        entries: chunk,
        totalEntries,
        fromSeq,
        toSeq,
        chunkIndex: i,
        totalChunks,
        requestId,
      };

      const json = JSON.stringify(msg);

      try {
        const conversationKey = getConversationKey(this.secretKey, phonePubkey);
        const ciphertext = encrypt(json, conversationKey);

        const event = finalizeEvent({
          kind: OUTPUT_EVENT_KIND,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['p', phonePubkey],
            ['s', sessionId],
            ['t', 'history'],
          ],
          content: ciphertext,
        }, this.secretKey);

        const results = this.pool.publish(this.relays, event);
        const outcomes = await Promise.allSettled(results);
        for (let j = 0; j < outcomes.length; j++) {
          if (outcomes[j].status === 'rejected') {
            const reason = (outcomes[j] as PromiseRejectedResult).reason;
            const msg2 = reason instanceof Error ? reason.message : String(reason);
            console.warn(`[Codedeck] Relay ${this.relays[j]}: history publish failed: ${msg2}`);
          }
        }
      } catch (err) {
        console.error(`[Codedeck] Failed to publish history chunk ${i + 1}/${totalChunks}:`, err);
      }

      // Delay between chunks to avoid overwhelming relays
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, NostrRelay.CHUNK_DELAY_MS));
      }
    }
  }

  /**
   * Split entries into chunks, with recursive size checking.
   */
  private splitIntoChunks(
    entries: Array<{ seq: number; entry: OutputEntry }>
  ): Array<Array<{ seq: number; entry: OutputEntry }>> {
    const chunks: Array<Array<{ seq: number; entry: OutputEntry }>> = [];

    for (let i = 0; i < entries.length; i += NostrRelay.HISTORY_CHUNK_SIZE) {
      const slice = entries.slice(i, i + NostrRelay.HISTORY_CHUNK_SIZE);
      this.splitIfOversized(slice, chunks);
    }

    // Edge case: 0 entries — send one empty chunk so phone clears loading state
    if (chunks.length === 0) {
      chunks.push([]);
    }

    return chunks;
  }

  /**
   * Recursively halve a chunk until it fits within MAX_CHUNK_JSON_BYTES,
   * or it's a single entry (irreducibly large).
   */
  private splitIfOversized(
    chunk: Array<{ seq: number; entry: OutputEntry }>,
    out: Array<Array<{ seq: number; entry: OutputEntry }>>,
  ): void {
    if (chunk.length <= 1 || JSON.stringify(chunk).length <= NostrRelay.MAX_CHUNK_JSON_BYTES) {
      out.push(chunk);
      return;
    }
    const mid = Math.ceil(chunk.length / 2);
    this.splitIfOversized(chunk.slice(0, mid), out);
    this.splitIfOversized(chunk.slice(mid), out);
  }

  private handleIncomingEvent(event: { pubkey: string; content: string; created_at: number }): void {
    // Safety net: ignore events older than 60s (in case relays don't enforce `since`)
    const now = Math.floor(Date.now() / 1000);
    if (event.created_at < now - 60) {
      console.log(`[Codedeck] Ignoring stale event (${now - event.created_at}s old)`);
      return;
    }

    // Verify it's from a paired phone
    const phone = this.pairedPhones.find(p => p.pubkeyHex === event.pubkey);
    if (!phone) {
      console.log(`[Codedeck] Ignoring event from unknown pubkey: ${event.pubkey.slice(0, 8)}...`);
      return;
    }

    try {
      // NIP-44 decrypt
      const conversationKey = getConversationKey(this.secretKey, event.pubkey);
      const plaintext = decrypt(event.content, conversationKey);
      const msg: BridgeInbound = JSON.parse(plaintext);

      console.log(`[Codedeck] Received ${msg.type} from ${phone.label} for session ${'sessionId' in msg ? msg.sessionId : 'N/A'}`);

      switch (msg.type) {
        case 'input':
          Promise.resolve(this.events.onInput(msg.sessionId, msg.text))
            .catch(err => console.error('[Codedeck] onInput handler error:', err));
          break;
        case 'permission-res':
          this.events.onPermissionResponse(msg.sessionId, msg.requestId, msg.allow);
          break;
        case 'mode':
          this.events.onModeChange(msg.sessionId, msg.mode);
          break;
        case 'history-request':
          this.events.onHistoryRequest(msg.sessionId, msg.afterSeq, event.pubkey);
          break;
        case 'create-session':
          Promise.resolve(this.events.onCreateSession())
            .catch(err => console.error('[Codedeck] onCreateSession handler error:', err));
          break;
      }
    } catch (err) {
      console.error('[Codedeck] Failed to decrypt/parse incoming event:', err);
    }
  }

  static generateSecretKey(): Uint8Array {
    return generateSecretKey();
  }
}