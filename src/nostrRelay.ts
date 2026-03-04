/**
 * Nostr relay transport for Codedeck Bridge.
 *
 * Protocol:
 * - Session list: NIP-33 replaceable events (kind 30515, d-tag = machine name).
 *   Relays keep only the latest version, so phones always get current session list.
 * - Output: Regular events (kind 4515) with seq counter per session.
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
  SessionPendingMessage,
  SessionReadyMessage,
  SessionFailedMessage,
  InputFailedMessage,
} from './types';
import { SESSION_LIST_EVENT_KIND, OUTPUT_EVENT_KIND } from './types';

export interface NostrRelayEvents {
  onInput: (sessionId: string, text: string, phonePubkey: string) => void;
  onPermissionResponse: (sessionId: string, requestId: string, allow: boolean, modifier?: 'always' | 'never') => void;
  onKeypress: (sessionId: string, key: string) => void;
  onModeChange: (sessionId: string, mode: string) => void;
  onHistoryRequest: (sessionId: string, afterSeq: number | undefined, phonePubkey: string) => void;
  onCreateSession: () => void;
  onRefreshSessions: () => void;
  onUploadImage: (msg: import('./types').UploadImageMessage, phonePubkey: string) => void;
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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private static readonly RECONNECT_BASE_MS = 2_000;
  private static readonly RECONNECT_MAX_MS = 30_000;
  private disposed = false;
  private log: (msg: string) => void;

  // --- Persistent last-seen timestamp ---
  // Tracks the most recent event we processed. Used as `since` on reconnect
  // to bridge the gap after a crash instead of using an arbitrary window.
  private _lastSeenTimestamp: number;

  // --- Output throttling ---
  // Queue output entries and flush at most once per interval to avoid relay rate-limits.
  private outputQueue: Array<{ sessionId: string; seq: number; entry: OutputEntry }> = [];
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly OUTPUT_FLUSH_INTERVAL_MS = 1_000;
  private static readonly OUTPUT_INTER_EVENT_DELAY_MS = 100;
  private static readonly MAX_EVENTS_PER_FLUSH = 5;

  // --- Output publish priority ---
  // Pause output flushing while a high-priority publish is in progress.
  private outputPaused = false;

  // --- Session list publish debounce ---
  // Coalesce rapid-fire publishSessionList calls (e.g. activation + oneose)
  private publishDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPublishSessions: RemoteSessionInfo[] | null = null;
  private publishDebounceCount = 0;

  // --- Monotonic timestamp for NIP-33 replaceable events ---
  // Ensures each session list event has a strictly newer created_at than the previous one,
  // preventing "replaced: have newer event" rejections from relays.
  private lastSessionListTimestamp = 0;

  constructor(
    secretKey: Uint8Array,
    relays: string[],
    pairedPhones: PairedPhone[],
    machineName: string,
    events: NostrRelayEvents,
    log?: (msg: string) => void,
    lastSeenTimestamp?: number,
  ) {
    this.secretKey = secretKey;
    this.pubkeyHex = getPublicKey(secretKey);
    this.relays = relays;
    this.pairedPhones = pairedPhones;
    this.events = events;
    this.machineName = machineName;
    this.log = log ?? console.log;
    this._lastSeenTimestamp = lastSeenTimestamp ?? 0;
  }

  /** Get the timestamp of the last processed event (for persistence). */
  get lastSeenTimestamp(): number {
    return this._lastSeenTimestamp;
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

    this.pool = new SimplePool({ enableReconnect: true });

    // Subscribe to events tagged to our pubkey from paired phones
    const phonePubkeys = this.pairedPhones.map(p => p.pubkeyHex);
    if (phonePubkeys.length === 0) {
      this.log('[Codedeck] No paired phones, skipping subscription');
      this.onConnectionChange?.('disconnected', 'No paired phones');
      return;
    }

    try {
      this.subscription = this.pool.subscribeMany(
        this.relays,
        // Listen for both output-kind and session-list-kind events from phones.
        // `since` uses persisted last-seen timestamp to bridge crash gaps,
        // falling back to 5-minute window if no timestamp was persisted.
        {
          kinds: [OUTPUT_EVENT_KIND, SESSION_LIST_EVENT_KIND],
          '#p': [this.pubkeyHex],
          authors: phonePubkeys,
          since: this._lastSeenTimestamp > 0
            ? this._lastSeenTimestamp - 5  // 5s grace before last-seen
            : Math.floor(Date.now() / 1000) - 300,  // fallback: 5-minute window
        },
        {
          onevent: (event) => {
            this.handleIncomingEvent(event);
          },
          oneose: () => {
            this.reconnectAttempt = 0; // reset on success
            this.log('[Codedeck] Connected to relays, subscription active');
            this.onConnectionChange?.('connected');
          },
          onclose: (reasons) => {
            this.log(`[Codedeck] Relay subscription closed: ${JSON.stringify(reasons)}`);
            this.onConnectionChange?.('disconnected', 'Relay connection lost — reconnecting');
            this.scheduleReconnect();
          },
        },
      );
    } catch (err) {
      console.error('[Codedeck] Failed to connect to relays:', err);
      this.onConnectionChange?.('error', String(err));
      this.scheduleReconnect();
    }
  }

  /** Schedule a reconnection attempt with exponential backoff (2s→30s cap). */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) { return; }
    if (this.pairedPhones.length === 0) { return; }
    const delay = Math.min(
      NostrRelay.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      NostrRelay.RECONNECT_MAX_MS,
    );
    this.reconnectAttempt++;
    this.log(`[Codedeck] Scheduling reconnect attempt ${this.reconnectAttempt} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) {
        this.connect();
      }
    }, delay);
  }

  disconnect(): void {
    const wasConnected = this.isConnected();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }
    if (this.publishDebounceTimer) {
      clearTimeout(this.publishDebounceTimer);
      this.publishDebounceTimer = null;
      this.pendingPublishSessions = null;
      this.publishDebounceCount = 0;
    }
    this.outputQueue.length = 0;
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

  /** Permanently shut down — prevents reconnection attempts after extension deactivation. */
  dispose(): void {
    this.disposed = true;
    this.disconnect();
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
   *
   * Debounced (500ms) to coalesce rapid-fire calls (e.g. activation + oneose).
   * Pauses output publishing while in progress to avoid relay rate-limits.
   * Retries once after 3s if all relays reject the publish.
   */
  async publishSessionList(sessions: RemoteSessionInfo[]): Promise<void> {
    if (!this.pool || this.pairedPhones.length === 0) {
      this.log(`[Codedeck] publishSessionList skipped: pool=${!!this.pool}, phones=${this.pairedPhones.length}`);
      return;
    }

    // Debounce: store latest sessions and reset timer
    this.pendingPublishSessions = sessions;
    this.publishDebounceCount++;

    if (this.publishDebounceTimer) {
      clearTimeout(this.publishDebounceTimer);
    }

    return new Promise<void>((resolve) => {
      this.publishDebounceTimer = setTimeout(async () => {
        this.publishDebounceTimer = null;
        const toPublish = this.pendingPublishSessions;
        const coalescedCalls = this.publishDebounceCount;
        this.pendingPublishSessions = null;
        this.publishDebounceCount = 0;

        if (!toPublish || !this.pool) {
          resolve();
          return;
        }

        if (coalescedCalls > 1) {
          this.log(`[Codedeck] publishSessionList: coalesced ${coalescedCalls} calls into 1`);
        }

        await this.doPublishSessionListWithRetry(toPublish);
        resolve();
      }, 500);
    });
  }

  /** Publish with retry logic. */
  private async doPublishSessionListWithRetry(sessions: RemoteSessionInfo[]): Promise<void> {
    // Pause output flushing so session list gets relay bandwidth priority
    this.outputPaused = true;

    try {
      const allFailed = await this.doPublishSessionList(sessions);

      // Retry once after delay if every relay rejected the publish
      if (allFailed && this.pool) {
        this.log('[Codedeck] Session list publish failed on all relays — retrying in 3s');
        await new Promise(resolve => setTimeout(resolve, 3_000));
        if (this.pool) {
          await this.doPublishSessionList(sessions);
        }
      }
    } finally {
      this.outputPaused = false;
    }
  }

  /** Get a monotonically increasing timestamp for NIP-33 events. */
  private getNextTimestamp(): number {
    const now = Math.floor(Date.now() / 1000);
    this.lastSessionListTimestamp = Math.max(now, this.lastSessionListTimestamp + 1);
    return this.lastSessionListTimestamp;
  }

  /** Internal: publish session list to all phones. Returns true if ALL relays failed. */
  private async doPublishSessionList(sessions: RemoteSessionInfo[]): Promise<boolean> {
    this.log(`[Codedeck] publishSessionList: ${sessions.length} sessions to ${this.pairedPhones.length} phones via ${this.relays.join(', ')}`);

    const msg: BridgeOutbound = {
      type: 'sessions',
      machine: this.machineName,
      sessions,
    };

    const json = JSON.stringify(msg);
    let anySuccess = false;
    const timestamp = this.getNextTimestamp();

    for (const phone of this.pairedPhones) {
      if (!this.pool) { return !anySuccess; }
      try {
        const conversationKey = getConversationKey(this.secretKey, phone.pubkeyHex);
        const ciphertext = encrypt(json, conversationKey);

        const event = finalizeEvent({
          kind: SESSION_LIST_EVENT_KIND,
          created_at: timestamp,
          tags: [
            ['p', phone.pubkeyHex],
            ['d', this.machineName], // NIP-33: identifier for replaceable event
          ],
          content: ciphertext,
        }, this.secretKey);

        this.log(`[Codedeck] Publishing session list event: id=${event.id.slice(0, 8)}, kind=${event.kind}, created_at=${timestamp}, content=${ciphertext.length} chars, to ${phone.label} (${phone.pubkeyHex.slice(0, 8)}...)`);
        const results = this.pool.publish(this.relays, event);
        const outcomes = await Promise.allSettled(results);
        for (let i = 0; i < outcomes.length; i++) {
          if (outcomes[i].status === 'fulfilled') {
            this.log(`[Codedeck] Relay ${this.relays[i]}: publish OK`);
            anySuccess = true;
          } else {
            const reason = (outcomes[i] as PromiseRejectedResult).reason;
            const errMsg = reason instanceof Error ? reason.message : String(reason);
            if (errMsg.includes('replaced') || errMsg.includes('newer event')) {
              // Relay already has this event (or a newer version) — treat as success
              this.log(`[Codedeck] Relay ${this.relays[i]}: publish OK (relay already has event: ${errMsg})`);
              anySuccess = true;
            } else {
              this.log(`[Codedeck] Relay ${this.relays[i]}: publish FAILED: ${errMsg}`);
            }
          }
        }
      } catch (err) {
        this.log(`[Codedeck] Failed to publish session list to ${phone.label}: ${err}`);
      }
    }

    if (anySuccess) { this.reconnectAttempt = 0; }
    this.log(`[Codedeck] publishSessionList result: anySuccess=${anySuccess}`);
    return !anySuccess;
  }

  /**
   * Queue output entries for throttled publishing.
   * Entries are batched and flushed at most once per OUTPUT_FLUSH_INTERVAL_MS
   * to avoid relay rate-limits. Each entry becomes a separate Nostr event
   * (preserving per-entry seq numbering) but they're sent in a timed batch.
   */
  private static readonly MAX_OUTPUT_QUEUE_SIZE = 500;

  async publishOutput(sessionId: string, entries: Array<{ seq: number; entry: OutputEntry }>): Promise<void> {
    if (!this.pool || this.pairedPhones.length === 0) { return; }

    for (const { seq, entry } of entries) {
      this.outputQueue.push({ sessionId, seq, entry });
    }

    // Cap queue to prevent unbounded growth during relay outages.
    // Inject a system entry so the phone knows output was lost.
    if (this.outputQueue.length > NostrRelay.MAX_OUTPUT_QUEUE_SIZE) {
      const dropped = this.outputQueue.length - NostrRelay.MAX_OUTPUT_QUEUE_SIZE;
      const droppedSessionId = this.outputQueue[0].sessionId;
      this.outputQueue.splice(0, dropped);
      this.log(`[Codedeck] Output queue overflow: dropped ${dropped} oldest entries`);

      // Prepend a notification entry so the phone sees the gap
      const gapEntry: { sessionId: string; seq: number; entry: OutputEntry } = {
        sessionId: droppedSessionId,
        seq: this.outputQueue.length > 0 ? this.outputQueue[0].seq - 1 : 0,
        entry: {
          entryType: 'system',
          content: `[Bridge: relay outage — ${dropped} output entries were lost]`,
          timestamp: new Date().toISOString(),
          metadata: { special: 'queue_overflow' },
        },
      };
      this.outputQueue.unshift(gapEntry);
    }

    // Start flush timer if not already running
    if (!this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => {
        this.outputFlushTimer = null;
        this.flushOutputQueue();
      }, NostrRelay.OUTPUT_FLUSH_INTERVAL_MS);
    }
  }

  /** Flush queued output entries to relays. Skipped while high-priority publish is in progress. */
  private async flushOutputQueue(): Promise<void> {
    // Defer if a high-priority publish is in progress (give it relay bandwidth)
    if (this.outputPaused) {
      this.log(`[Codedeck] flushOutputQueue: deferred (priority publish in progress), ${this.outputQueue.length} entries queued`);
      if (this.outputQueue.length > 0 && !this.outputFlushTimer) {
        this.outputFlushTimer = setTimeout(() => {
          this.outputFlushTimer = null;
          this.flushOutputQueue();
        }, NostrRelay.OUTPUT_FLUSH_INTERVAL_MS);
      }
      return;
    }

    if (!this.pool || this.pairedPhones.length === 0 || this.outputQueue.length === 0) { return; }

    // Take at most MAX_EVENTS_PER_FLUSH entries to avoid burning through rate limits
    const count = Math.min(this.outputQueue.length, NostrRelay.MAX_EVENTS_PER_FLUSH);
    const batch = this.outputQueue.splice(0, count);
    const remaining = this.outputQueue.length;
    this.log(`[Codedeck] flushOutputQueue: sending ${batch.length} entries to ${this.pairedPhones.length} phones${remaining > 0 ? ` (${remaining} remaining)` : ''}`);

    for (let idx = 0; idx < batch.length; idx++) {
      const { sessionId, seq, entry } = batch[idx];
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

      // Inter-event delay to avoid relay rate-limiting (skip after last entry)
      if (idx < batch.length - 1) {
        await new Promise(resolve => setTimeout(resolve, NostrRelay.OUTPUT_INTER_EVENT_DELAY_MS));
      }
    }

    // If there are remaining entries, schedule the next flush
    if (this.outputQueue.length > 0 && !this.outputFlushTimer) {
      this.outputFlushTimer = setTimeout(() => {
        this.outputFlushTimer = null;
        this.flushOutputQueue();
      }, NostrRelay.OUTPUT_FLUSH_INTERVAL_MS);
    }
  }

  // --- Two-phase session creation ---

  /**
   * Publish a message to all paired phones using OUTPUT_EVENT_KIND with NIP-40 expiration.
   * Pauses output flushing during publish. Retries with exponential backoff if all relays reject.
   * Returns true if at least one relay accepted the event.
   */
  private async publishToAllPhones(msg: BridgeOutbound, expirationSecs: number, retries: number = 0): Promise<boolean> {
    if (!this.pool || this.pairedPhones.length === 0) { return false; }

    this.outputPaused = true;
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (!this.pool) { return false; }

        const json = JSON.stringify(msg);
        const expiration = String(Math.floor(Date.now() / 1000) + expirationSecs);
        let anySuccess = false;

        for (const phone of this.pairedPhones) {
          if (!this.pool) { return anySuccess; }
          try {
            const conversationKey = getConversationKey(this.secretKey, phone.pubkeyHex);
            const ciphertext = encrypt(json, conversationKey);

            const event = finalizeEvent({
              kind: OUTPUT_EVENT_KIND,
              created_at: Math.floor(Date.now() / 1000),
              tags: [
                ['p', phone.pubkeyHex],
                ['expiration', expiration],
              ],
              content: ciphertext,
            }, this.secretKey);

            const results = this.pool.publish(this.relays, event);
            const outcomes = await Promise.allSettled(results);
            for (let i = 0; i < outcomes.length; i++) {
              if (outcomes[i].status === 'fulfilled') {
                anySuccess = true;
              } else {
                const msg2 = (outcomes[i] as PromiseRejectedResult).reason;
                const errStr = msg2 instanceof Error ? msg2.message : String(msg2);
                console.warn(`[Codedeck] Relay ${this.relays[i]}: publish failed: ${errStr}`);
              }
            }
          } catch (err) {
            console.error(`[Codedeck] Failed to publish to ${phone.label}:`, err);
          }
        }

        if (anySuccess) { this.reconnectAttempt = 0; return true; }

        if (attempt < retries) {
          const delay = 2_000 * Math.pow(2, attempt); // 2s, 4s
          this.log(`[Codedeck] Publish failed on all relays — retry ${attempt + 1}/${retries} in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      return false;
    } finally {
      this.outputPaused = false;
    }
  }

  /** Publish session-pending acknowledgment (NIP-40: expires in 2 minutes). */
  async publishSessionPending(pendingId: string): Promise<boolean> {
    const msg: SessionPendingMessage = {
      type: 'session-pending',
      pendingId,
      machine: this.machineName,
      createdAt: new Date().toISOString(),
    };
    this.log(`[Codedeck] Publishing session-pending: ${pendingId}`);
    return this.publishToAllPhones(msg, 120);
  }

  /** Publish session-ready upgrade with real session info (NIP-40: expires in 1 minute). */
  async publishSessionReady(pendingId: string, session: RemoteSessionInfo): Promise<boolean> {
    const msg: SessionReadyMessage = {
      type: 'session-ready',
      pendingId,
      session,
    };
    this.log(`[Codedeck] Publishing session-ready: ${pendingId} → ${session.id}`);
    return this.publishToAllPhones(msg, 60, 2);
  }

  /** Publish session-failed with reason (NIP-40: expires in 1 minute). */
  async publishSessionFailed(pendingId: string, reason: string): Promise<boolean> {
    const msg: SessionFailedMessage = {
      type: 'session-failed',
      pendingId,
      reason,
    };
    this.log(`[Codedeck] Publishing session-failed: ${pendingId} (${reason})`);
    return this.publishToAllPhones(msg, 60);
  }

  /** Publish input-failed feedback when input can't be routed to a terminal (NIP-40: expires in 60s). */
  async publishInputFailed(sessionId: string, reason: 'no-terminal' | 'expired'): Promise<boolean> {
    const msg: InputFailedMessage = {
      type: 'input-failed',
      sessionId,
      reason,
    };
    this.log(`[Codedeck] Publishing input-failed: session=${sessionId}, reason=${reason}`);
    return this.publishToAllPhones(msg, 60);
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

    this.log(`[Codedeck] publishHistory: ${entries.length} entries in ${totalChunks} chunks for session ${sessionId}`);

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
    if (event.created_at < now - 300) {
      this.log(`[Codedeck] Ignoring stale event (${now - event.created_at}s old)`);
      return;
    }

    // Verify it's from a paired phone
    const phone = this.pairedPhones.find(p => p.pubkeyHex === event.pubkey);
    if (!phone) {
      this.log(`[Codedeck] Ignoring event from unknown pubkey: ${event.pubkey.slice(0, 8)}...`);
      return;
    }

    try {
      // NIP-44 decrypt
      const conversationKey = getConversationKey(this.secretKey, event.pubkey);
      const plaintext = decrypt(event.content, conversationKey);
      const msg: BridgeInbound = JSON.parse(plaintext);

      // Track last-seen event timestamp for crash-recovery since filter
      if (event.created_at > this._lastSeenTimestamp) {
        this._lastSeenTimestamp = event.created_at;
      }

      this.log(`[Codedeck] Received ${msg.type} from ${phone.label} for session ${'sessionId' in msg ? msg.sessionId : 'N/A'}`);

      switch (msg.type) {
        case 'input':
          Promise.resolve(this.events.onInput(msg.sessionId, msg.text, event.pubkey))
            .catch(err => console.error('[Codedeck] onInput handler error:', err));
          break;
        case 'permission-res':
          Promise.resolve(this.events.onPermissionResponse(msg.sessionId, msg.requestId, msg.allow, msg.modifier))
            .catch(err => console.error('[Codedeck] onPermissionResponse handler error:', err));
          break;
        case 'keypress':
          Promise.resolve(this.events.onKeypress(msg.sessionId, msg.key))
            .catch(err => console.error('[Codedeck] onKeypress handler error:', err));
          break;
        case 'mode':
          Promise.resolve(this.events.onModeChange(msg.sessionId, msg.mode))
            .catch(err => console.error('[Codedeck] onModeChange handler error:', err));
          break;
        case 'history-request':
          this.events.onHistoryRequest(msg.sessionId, msg.afterSeq, event.pubkey);
          break;
        case 'create-session':
          Promise.resolve(this.events.onCreateSession())
            .catch(err => this.log(`[Codedeck] onCreateSession handler error: ${err}`));
          break;
        case 'refresh-sessions':
          Promise.resolve(this.events.onRefreshSessions())
            .catch(err => this.log(`[Codedeck] onRefreshSessions handler error: ${err}`));
          break;
        case 'upload-image':
          this.events.onUploadImage(msg, event.pubkey);
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