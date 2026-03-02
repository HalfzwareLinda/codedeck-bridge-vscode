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

export interface PermissionResponseMessage {
  type: 'permission-res';
  sessionId: string;
  requestId: string;
  allow: boolean;
  /** Optional modifier: 'always' → always allow this tool, 'never' → don't ask again (deny). */
  modifier?: 'always' | 'never';
}

export interface ModeChangeMessage {
  type: 'mode';
  sessionId: string;
  mode: 'plan' | 'auto';
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

// --- Image upload (phone → bridge, chunked) ---

export interface UploadImageMessage {
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

// --- Union ---

export type BridgeOutbound = SessionListMessage | OutputMessage | HistoryResponseMessage | SessionPendingMessage | SessionReadyMessage | SessionFailedMessage;
export type BridgeInbound = InputMessage | PermissionResponseMessage | ModeChangeMessage | HistoryRequestMessage | CreateSessionMessage | RefreshSessionsMessage | UploadImageMessage;
export type BridgeMessage = BridgeOutbound | BridgeInbound;

// --- Nostr event kinds ---

/** Replaceable event kind for session list (NIP-33 parameterized replaceable: 30000-39999) */
export const SESSION_LIST_EVENT_KIND = 30515;

/** Regular event kind for output/messages (stored by relays, retrievable for catch-up).
 *  Must be in range 1-9999 (regular events). Was 29515 which falls in 20000-29999 (ephemeral)
 *  and caused unreliable delivery — relays dropped events instead of storing/forwarding them. */
export const OUTPUT_EVENT_KIND = 4515;

// --- Claude Code JSONL types (what we parse from session files) ---

export interface ClaudeJsonlUser {
  type: 'user';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  cwd: string;
  slug?: string;
  timestamp?: string;
  message: {
    role: 'user';
    content: ClaudeContentBlock[];
  };
}

export interface ClaudeJsonlAssistant {
  type: 'assistant';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  cwd: string;
  slug?: string;
  timestamp?: string;
  message: {
    role: 'assistant';
    model?: string;
    content: ClaudeContentBlock[];
    stop_reason?: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

export interface ClaudeJsonlSystem {
  type: 'system';
  subtype?: string;
  content?: string;
  timestamp?: string;
  uuid: string;
}

export interface ClaudeJsonlProgress {
  type: 'progress';
  uuid: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  toolUseID?: string;
}

export interface ClaudeJsonlSnapshot {
  type: 'file-history-snapshot';
  messageId: string;
}

export interface ClaudeJsonlQueueOp {
  type: 'queue-operation';
  operation: string;
  timestamp?: string;
  sessionId: string;
}

export type ClaudeJsonlLine =
  | ClaudeJsonlUser
  | ClaudeJsonlAssistant
  | ClaudeJsonlSystem
  | ClaudeJsonlProgress
  | ClaudeJsonlSnapshot
  | ClaudeJsonlQueueOp;

// Content blocks inside Claude messages
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string | ClaudeContentBlock[] };

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
