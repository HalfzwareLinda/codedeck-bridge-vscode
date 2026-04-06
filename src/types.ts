/**
 * Shared types for the Codedeck Bridge protocol.
 *
 * These types define the message format exchanged between the VSCode extension
 * (bridge) and the Codedeck mobile app over Nostr relays.
 */

// --- Session Discovery ---

export interface RemoteSessionInfo {
  id: string;
  slug: string;
  cwd: string;
  lastActivity: string;
  lineCount: number;
  title: string | null;
  project: string;
  hasTerminal?: boolean;
  permissionMode?: PermissionMode;
}

export interface SessionListMessage {
  type: 'sessions';
  machine: string;
  sessions: RemoteSessionInfo[];
}

// --- Output Relay (bridge → phone) ---

export type OutputEntryType = 'text' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'progress';

export interface OutputEntry {
  entryType: OutputEntryType;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface OutputMessage {
  type: 'output';
  sessionId: string;
  seq: number;
  entry: OutputEntry;
}

// --- Input (phone → bridge) ---

export interface InputMessage {
  type: 'input';
  sessionId: string;
  text: string;
}

/** Free-text answer to a pending AskUserQuestion. The bridge selects the
 *  "Type something" Ink TUI option (keypress optionCount+1), waits for the
 *  mode switch, then sends the text directly (no Escape workaround). */
export interface QuestionInputMessage {
  type: 'question-input';
  sessionId: string;
  text: string;
  optionCount: number;
}

export interface PermissionResponseMessage {
  type: 'permission-res';
  sessionId: string;
  requestId: string;
  allow: boolean;
  /** Optional modifier: 'always' → always allow this tool, 'never' → don't ask again (deny). */
  modifier?: 'always' | 'never';
}

/** Single raw keypress for Claude Code's Ink TUI prompts (plan approval, question selection). */
export interface KeypressMessage {
  type: 'keypress';
  sessionId: string;
  key: string;
  context?: 'plan-approval' | 'question';
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan';

export interface ModeChangeMessage {
  type: 'mode';
  sessionId: string;
  mode: PermissionMode;
}

// --- History catch-up (phone → bridge → phone) ---

export interface HistoryRequestMessage {
  type: 'history-request';
  sessionId: string;
  afterSeq?: number; // resume from this seq, or 0/undefined for full history
}

export interface HistoryResponseMessage {
  type: 'history';
  sessionId: string;
  entries: Array<{ seq: number; entry: OutputEntry }>;
  totalEntries: number;
  fromSeq: number;
  toSeq: number;
  chunkIndex: number;   // 0-based index of this chunk
  totalChunks: number;  // total number of chunks in this response
  requestId: string;    // unique ID to correlate chunks from the same request
}

// --- Session creation (phone → bridge) ---

export interface CreateSessionMessage {
  type: 'create-session';
}

// --- Refresh sessions (phone → bridge) ---

export interface RefreshSessionsMessage {
  type: 'refresh-sessions';
}

// --- Close session (phone → bridge) ---

export interface CloseSessionMessage {
  type: 'close-session';
  sessionId: string;
}

// --- Image upload (phone → bridge) ---

/** Legacy chunked upload (pre-Blossom) */
export interface UploadImageChunkMessage {
  type: 'upload-image';
  sessionId: string;
  uploadId: string;
  filename: string;
  mimeType: string;
  base64Data: string;
  text: string;
  chunkIndex: number;
  totalChunks: number;
}

/** Blossom upload — single event with hash reference to AES-256-GCM encrypted blob */
export interface UploadImageBlossomMessage {
  type: 'upload-image';
  sessionId: string;
  hash: string;
  url: string;
  key: string;
  iv: string;
  filename: string;
  mimeType: string;
  text: string;
  sizeBytes: number;
}

export type UploadImageMessage = UploadImageChunkMessage | UploadImageBlossomMessage;

// --- Two-phase session creation (bridge → phone) ---

export interface SessionPendingMessage {
  type: 'session-pending';
  pendingId: string;    // bridge-generated UUID
  machine: string;
  createdAt: string;    // ISO timestamp
}

export interface SessionReadyMessage {
  type: 'session-ready';
  pendingId: string;
  session: RemoteSessionInfo;
}

export interface SessionFailedMessage {
  type: 'session-failed';
  pendingId: string;
  reason: string;       // 'timeout' | 'terminal-failed'
}

// --- Input delivery feedback (bridge → phone) ---

export interface InputFailedMessage {
  type: 'input-failed';
  sessionId: string;
  reason: 'no-terminal' | 'expired';
}

// --- Close session acknowledgment (bridge → phone) ---

export interface CloseSessionAckMessage {
  type: 'close-session-ack';
  sessionId: string;
  success: boolean;
}

// --- Session replacement (bridge → phone) ---

export interface SessionReplacedMessage {
  type: 'session-replaced';
  oldSessionId: string;
  newSession: RemoteSessionInfo;
}

// --- Mode confirmation (bridge → phone) ---

export interface ModeConfirmedMessage {
  type: 'mode-confirmed';
  sessionId: string;
  mode: PermissionMode;
}

// --- Union ---

export type BridgeOutbound = SessionListMessage | OutputMessage | HistoryResponseMessage | SessionPendingMessage | SessionReadyMessage | SessionFailedMessage | InputFailedMessage | CloseSessionAckMessage | SessionReplacedMessage | ModeConfirmedMessage;
export type BridgeInbound = InputMessage | QuestionInputMessage | PermissionResponseMessage | KeypressMessage | ModeChangeMessage | HistoryRequestMessage | CreateSessionMessage | RefreshSessionsMessage | CloseSessionMessage | UploadImageMessage;
export type BridgeMessage = BridgeOutbound | BridgeInbound;

// --- Nostr event kinds ---

/** Replaceable event kind for session list (NIP-33 parameterized replaceable: 30000-39999) */
export const SESSION_LIST_EVENT_KIND = 30515;

/** Regular event kind for output/messages (stored by relays, retrievable for catch-up).
 *  Must be in range 1-9999 (regular events). Was 29515 which falls in 20000-29999 (ephemeral)
 *  and caused unreliable delivery — relays dropped events instead of storing/forwarding them. */
export const OUTPUT_EVENT_KIND = 4515;

// --- Pairing ---

export interface PairingInfo {
  npub: string;
  relays: string[];
  machine: string;
}

export interface PairedPhone {
  npub: string;
  pubkeyHex: string;
  label: string;
  pairedAt: string;
}
