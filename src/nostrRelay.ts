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
import { encrypt, decrypt } from 'nostr-tools/nip44';
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
  private seqCounters: Map<string, number> = new Map(); // per-session seq counter

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

  getSeq(sessionId: string): number {
    return this.seqCounters.get(sessionId) ?? 0;
  }

  connect(): void {
    this.disconnect();

    this.pool = new SimplePool();

    // Subscribe to events tagged to our pubkey from paired phones
    const phonePubkeys = this.pairedPhones.map(p => p.pubkeyHex);
    if (phonePubkeys.length === 0) {
      console.log('[Codedeck] No paired phones, skipping subscription');
      return;
    }

    this.subscription = this.pool.subscribeMany(
      this.relays,
      // Listen for both output-kind and session-list-kind events from phones
      { kinds: [OUTPUT_EVENT_KIND, SESSION_LIST_EVENT_KIND], '#p': [this.pubkeyHex], authors: phonePubkeys },
      {
        onevent: (event) => {
          this.handleIncomingEvent(event);
        },
        oneose: () => {
          console.log('[Codedeck] Connected to relays, subscription active');
        },
      },
    );
  }

  disconnect(): void {
    if (this.subscription) {
      this.subscription.close();
      this.subscription = null;
    }
    if (this.pool) {
      this.pool.destroy();
      this.pool = null;
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
    if (!this.pool || this.pairedPhones.length === 0) { return; }

    const msg: BridgeOutbound = {
      type: 'sessions',
      machine: this.machineName,
      sessions,
    };

    const json = JSON.stringify(msg);

    for (const phone of this.pairedPhones) {
      if (!this.pool) { return; }
      try {
        const conversationKey = nip44GetConversationKey(this.secretKey, phone.pubkeyHex);
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

        await this.pool.publish(this.relays, event);
      } catch (err) {
        console.error(`[Codedeck] Failed to publish session list to ${phone.label}:`, err);
      }
    }
  }

  /**
   * Publish output entries as regular events with seq counter.
   * Regular kind 29515 events are stored by relays for catch-up.
   */
  async publishOutput(sessionId: string, entries: OutputEntry[]): Promise<void> {
    if (!this.pool || this.pairedPhones.length === 0) { return; }

    for (const entry of entries) {
      const seq = (this.seqCounters.get(sessionId) ?? 0) + 1;
      this.seqCounters.set(sessionId, seq);

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
          const conversationKey = nip44GetConversationKey(this.secretKey, phone.pubkeyHex);
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

          await this.pool.publish(this.relays, event);
        } catch (err) {
          console.error(`[Codedeck] Failed to publish output to ${phone.label}:`, err);
        }
      }
    }
  }

  /**
   * Send history response to a specific phone.
   */
  async publishHistory(
    phonePubkey: string,
    sessionId: string,
    entries: Array<{ seq: number; entry: OutputEntry }>,
    totalEntries: number,
  ): Promise<void> {
    if (!this.pool) { return; }

    const fromSeq = entries.length > 0 ? entries[0].seq : 0;
    const toSeq = entries.length > 0 ? entries[entries.length - 1].seq : 0;

    const msg: BridgeOutbound = {
      type: 'history',
      sessionId,
      entries,
      totalEntries,
      fromSeq,
      toSeq,
    };

    const json = JSON.stringify(msg);

    try {
      const conversationKey = nip44GetConversationKey(this.secretKey, phonePubkey);
      const ciphertext = encrypt(json, conversationKey);

      const event = finalizeEvent({
        kind: OUTPUT_EVENT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', phonePubkey],
          ['s', sessionId],
          ['t', 'history'], // tag to distinguish history responses
        ],
        content: ciphertext,
      }, this.secretKey);

      await this.pool.publish(this.relays, event);
    } catch (err) {
      console.error(`[Codedeck] Failed to publish history:`, err);
    }
  }

  private handleIncomingEvent(event: { pubkey: string; content: string }): void {
    // Verify it's from a paired phone
    const phone = this.pairedPhones.find(p => p.pubkeyHex === event.pubkey);
    if (!phone) { return; }

    try {
      // NIP-44 decrypt
      const conversationKey = nip44GetConversationKey(this.secretKey, event.pubkey);
      const plaintext = decrypt(event.content, conversationKey);
      const msg: BridgeInbound = JSON.parse(plaintext);

      switch (msg.type) {
        case 'input':
          this.events.onInput(msg.sessionId, msg.text);
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
      }
    } catch (err) {
      console.error('[Codedeck] Failed to decrypt/parse incoming event:', err);
    }
  }

  static generateSecretKey(): Uint8Array {
    return generateSecretKey();
  }
}

/**
 * Derive NIP-44 conversation key.
 * nostr-tools nip44 requires the conversation key to be derived separately.
 */
function nip44GetConversationKey(sk: Uint8Array, recipientPubkeyHex: string): Uint8Array {
  const { getConversationKey } = require('nostr-tools/nip44') as {
    getConversationKey: (sk: Uint8Array, pk: string) => Uint8Array;
  };
  return getConversationKey(sk, recipientPubkeyHex);
}
