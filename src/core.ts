/**
 * Core bridge orchestrator — coordinates Nostr relay ↔ SDK sessions.
 *
 * This module is the extraction boundary: everything here is pure Node.js.
 * The VSCode extension (extension.ts) is a thin wrapper that provides
 * configuration, pairing UI, and status bar.
 *
 * Architecture (post SDK migration):
 *   Phone ──Nostr──> NostrRelay → BridgeCore → SdkSessionManager → SDK → Claude Code subprocess
 *   Claude Code subprocess → SDK → SdkSessionManager → BridgeCore → NostrRelay ──Nostr──> Phone
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { NostrRelay, NostrRelayEvents } from './nostrRelay';
import { SdkSessionManager } from './sdkSession';
import type { OutputEntry, RemoteSessionInfo, PairedPhone, UploadImageBlossomMessage, UploadImageChunkMessage } from './types';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export interface BridgeCoreConfig {
  secretKey: Uint8Array;
  relays: string[];
  machineName: string;
  pairedPhones: PairedPhone[];
  workspaceCwd?: string;
  lastSeenTimestamp?: number;
}

/**
 * Core bridge that wires up Nostr relay ↔ SDK session manager.
 * Does not depend on VSCode APIs.
 */
interface ImageUploadTracker {
  sessionId: string;
  filename: string;
  mimeType: string;
  text: string;
  totalChunks: number;
  received: Map<number, string>;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class BridgeCore {
  private static readonly IMAGE_ASSEMBLY_TIMEOUT_MS = 60_000;

  public readonly relay: NostrRelay;
  public readonly sdk: SdkSessionManager;
  private workspaceCwd: string;
  private imageChunks: Map<string, ImageUploadTracker> = new Map();
  private log: (msg: string) => void;

  constructor(config: BridgeCoreConfig, log: (msg: string) => void = console.log) {
    this.workspaceCwd = config.workspaceCwd ?? '';
    this.log = log;

    // --- SDK Session Manager ---
    this.sdk = new SdkSessionManager({
      onOutput: (sessionId, entries) => {
        this.relay.publishOutput(sessionId, entries).catch(err => {
          console.error('[Codedeck] Failed to publish output:', err);
        });
      },
      onPermissionRequest: (request) => {
        // Emit permission card to phone via a system entry with special metadata
        const entry: OutputEntry = {
          entryType: 'system',
          content: request.title || `Permission needed: ${request.toolName}`,
          timestamp: new Date().toISOString(),
          metadata: {
            special: 'permission_request',
            tool_name: request.toolName,
            tool_use_id: request.toolUseId,
            tool_input: request.toolInput,
            description: request.description,
          },
        };
        this.relay.publishOutput(request.sessionId, [{ seq: 0, entry }]).catch(err => {
          console.error('[Codedeck] Failed to publish permission request:', err);
        });
      },
      onAskQuestion: (_sessionId, _toolUseId, _questions) => {
        // AskUserQuestion entries are already emitted by sdkAdapter in the
        // assistant message output stream — no extra action needed here.
      },
      onAutoModeChange: (sessionId, mode) => {
        this.relay.publishModeConfirmed(sessionId, mode).catch(err => {
          log(`[Codedeck] Failed to publish auto mode-confirmed: ${err}`);
        });
      },
      onSessionListChanged: (sessions) => {
        this.relay.publishSessionList(sessions).catch(err => {
          console.error('[Codedeck] Failed to publish session list:', err);
        });
      },
      onSessionEnded: (sessionId) => {
        log(`[Codedeck] Session ${sessionId} ended`);
      },
      onAuthError: (sessionId, error) => {
        log(`[Codedeck] AUTH ERROR for session ${sessionId}: ${error}`);
        // Emit error to phone so user sees a clear message
        const entry: OutputEntry = {
          entryType: 'error',
          content: `Authentication failed: ${error}`,
          timestamp: new Date().toISOString(),
          metadata: { special: 'auth_error' },
        };
        this.relay.publishOutput(sessionId, [{ seq: 0, entry }]).catch(err => {
          console.error('[Codedeck] Failed to publish auth error:', err);
        });
        this.relay.publishSessionFailed(sessionId, 'auth-failed').catch(err => {
          console.error('[Codedeck] Failed to publish session-failed:', err);
        });
      },
      onAuthSuccess: (sessionId, info) => {
        log(`[Codedeck] Session ${sessionId} authenticated: ${info.model} via ${info.apiKeySource} (v${info.version})`);
      },
      log,
    });

    // --- Nostr relay events (phone → bridge) ---
    const relayEvents: NostrRelayEvents = {
      onInput: async (sessionId, text, _phonePubkey) => {
        log(`[Codedeck] Input for session ${sessionId}: ${text.slice(0, 50)}...`);
        const sent = this.sdk.sendInput(sessionId, text);
        if (!sent) {
          log(`[Codedeck] No SDK session for ${sessionId}`);
          this.relay.publishInputFailed(sessionId, 'no-terminal').catch(err => {
            console.error('[Codedeck] Failed to publish input-failed:', err);
          });
        }
      },
      onQuestionInput: async (sessionId, text, _optionCount, _phonePubkey) => {
        log(`[Codedeck] Question input for session ${sessionId}: ${text.slice(0, 50)}...`);
        // With the SDK, question answers go through the same input channel.
        // The SDK handles routing it to the pending AskUserQuestion tool.
        const sent = this.sdk.sendQuestionInput(sessionId, text);
        if (!sent) {
          this.relay.publishInputFailed(sessionId, 'no-terminal').catch(err => {
            console.error('[Codedeck] Failed to publish input-failed:', err);
          });
        }
      },
      onCreateSession: async (defaultEffort?) => {
        const sessionId = crypto.randomUUID();
        log(`[Codedeck] Create session request — spawning SDK session ${sessionId}${defaultEffort ? ` (effort: ${defaultEffort})` : ''}`);

        try {
          const cwd = this.workspaceCwd || process.cwd();
          this.sdk.createSession(sessionId, cwd, 'plan');

          // Publish session-pending so the phone creates a placeholder
          await this.relay.publishSessionPending(sessionId);

          // Brief delay for relay rate-limiting
          await new Promise(resolve => setTimeout(resolve, 1_000));

          // Build session info
          const project = cwd.split('/').pop() || cwd;
          const session: RemoteSessionInfo = {
            id: sessionId,
            cwd,
            slug: `session-${sessionId.slice(0, 8)}`,
            lastActivity: new Date().toISOString(),
            lineCount: 0,
            title: null,
            project,
            permissionMode: 'plan',
          };

          // Apply default effort if requested
          if (defaultEffort) {
            await this.sdk.setEffortLevel(sessionId, defaultEffort);
          }

          // Publish session-ready
          log(`[Codedeck] Publishing session-ready for ${sessionId}`);
          const success = await this.relay.publishSessionReady(sessionId, session);
          if (!success) {
            log(`[Codedeck] WARNING: session-ready for ${sessionId} failed on all relays`);
          }
        } catch (err) {
          log(`[Codedeck] Session creation failed for ${sessionId}: ${err}`);
          await this.relay.publishSessionFailed(sessionId, 'terminal-failed');
        }
      },
      onPermissionResponse: async (sessionId, requestId, allow, modifier) => {
        log(`[Codedeck] Permission response for ${sessionId}: ${allow ? 'allow' : 'deny'}${modifier ? ` (${modifier})` : ''}`);
        this.sdk.resolvePermission(sessionId, requestId, allow, modifier);
      },
      onKeypress: async (sessionId, key, context?) => {
        log(`[Codedeck] Keypress for session ${sessionId}: ${key}${context ? ` (context: ${context})` : ''}`);

        // Plan approval: resolve the pending ExitPlanMode tool permission,
        // then set the appropriate mode for subsequent tools.
        if (context === 'plan-approval') {
          switch (key) {
            case '1': {
              // Approve plan + auto-accept edits
              const tid1 = this.sdk.findPendingPermission(sessionId, 'ExitPlanMode');
              if (tid1) this.sdk.resolvePermission(sessionId, tid1, true);
              await this.sdk.setPermissionMode(sessionId, 'acceptEdits');
              this.relay.publishModeConfirmed(sessionId, 'acceptEdits').catch(err => {
                log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
              });
              break;
            }
            case '2': {
              // Approve plan + manual edits
              const tid2 = this.sdk.findPendingPermission(sessionId, 'ExitPlanMode');
              if (tid2) this.sdk.resolvePermission(sessionId, tid2, true);
              await this.sdk.setPermissionMode(sessionId, 'default');
              this.relay.publishModeConfirmed(sessionId, 'default').catch(err => {
                log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
              });
              break;
            }
            case '3': {
              // Revise plan — deny ExitPlanMode so Claude stays in plan mode.
              // The user's revision text will arrive as the next input message.
              const toolUseId = this.sdk.findPendingPermission(sessionId, 'ExitPlanMode');
              if (toolUseId) {
                this.sdk.resolvePermission(sessionId, toolUseId, false);
              }
              break;
            }
          }
        }
        // Question option selection: map keypress number → option label → sendInput
        if (context === 'question') {
          const sent = this.sdk.resolveQuestionKeypress(sessionId, key);
          if (!sent) {
            log(`[Codedeck] No pending question for keypress '${key}' in ${sessionId}`);
          }
        }

        // Exit plan mode (plan-less ExitPlanMode): key '1' = yes, exit plan mode
        if (context === 'exit-plan') {
          if (key === '1') {
            await this.sdk.setPermissionMode(sessionId, 'default');
            this.relay.publishModeConfirmed(sessionId, 'default').catch(err => {
              log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
            });
          }
          // key '2' = No, stay in plan mode — no action needed
        }
      },
      onModeChange: async (sessionId, mode) => {
        log(`[Codedeck] Mode change for session ${sessionId}: ${mode}`);
        const sdkMode = (mode === 'bypassPermissions' ? 'default' : mode) as PermissionMode;
        const success = await this.sdk.setPermissionMode(sessionId, sdkMode);
        if (success) {
          this.relay.publishModeConfirmed(sessionId, mode).catch(err => {
            log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
          });
        }
      },
      onEffortChange: async (sessionId, effort) => {
        log(`[Codedeck] Effort change for session ${sessionId}: ${effort}`);
        const { confirmedLevel } = await this.sdk.setEffortLevel(sessionId, effort);
        // Always confirm back so the phone UI stays in sync, even if the level was unsupported
        this.relay.publishEffortConfirmed(sessionId, confirmedLevel).catch(err => {
          log(`[Codedeck] Failed to publish effort-confirmed: ${err}`);
        });
      },
      onHistoryRequest: async (sessionId, afterSeq, _phonePubkey) => {
        log(`[Codedeck] History request for ${sessionId} (afterSeq: ${afterSeq})`);

        // Try in-memory history first
        let entries = this.sdk.getHistory(sessionId, afterSeq);

        // Fall back to persisted JSONL history if memory is empty
        if (entries.length === 0 && (afterSeq === undefined || afterSeq === 0)) {
          log(`[Codedeck] No in-memory history for ${sessionId} — loading from disk`);
          entries = await this.sdk.getPersistedHistory(sessionId, this.workspaceCwd || undefined);
        }

        const totalEntries = entries.length || this.sdk.getHistoryCount(sessionId);
        log(`[Codedeck] Sending ${entries.length} history entries (total: ${totalEntries}) for ${sessionId}`);
        this.relay.publishHistory(_phonePubkey, sessionId, entries, totalEntries).catch(err => {
          console.error('[Codedeck] Failed to publish history:', err);
        });
      },
      onRefreshSessions: () => {
        log('[Codedeck] Refresh sessions request');
        const sessions = this.sdk.getSessions();
        this.relay.publishSessionList(sessions).catch(err => {
          console.error('[Codedeck] Failed to publish session list:', err);
        });
      },
      onCloseSession: async (sessionId) => {
        log(`[Codedeck] Close session request for ${sessionId}`);
        const found = this.sdk.closeSession(sessionId);
        // Re-publish session list
        const sessions = this.sdk.getSessions();
        this.relay.publishSessionList(sessions).catch(err => {
          console.error('[Codedeck] Failed to publish session list:', err);
        });
        this.relay.publishCloseSessionAck(sessionId, found).catch(err => {
          console.error('[Codedeck] Failed to publish close-session-ack:', err);
        });
      },
      onUploadImage: (msg, _phonePubkey) => {
        if ('hash' in msg) {
          this.handleBlossomImage(msg as UploadImageBlossomMessage);
        } else {
          const chunk = msg as UploadImageChunkMessage;
          this.handleImageChunk(chunk.sessionId, chunk.uploadId, chunk.filename, chunk.mimeType, chunk.base64Data, chunk.text, chunk.chunkIndex, chunk.totalChunks);
        }
      },
    };

    this.relay = new NostrRelay(
      config.secretKey,
      config.relays,
      config.pairedPhones,
      config.machineName,
      relayEvents,
      log,
      config.lastSeenTimestamp,
    );
  }

  /** Connect to Nostr relays if phones are paired. */
  connect(): void {
    this.relay.connect();
  }

  /** Disconnect from Nostr relays. */
  disconnect(): void {
    this.relay.disconnect();
  }

  /** Dispose all resources. */
  dispose(): void {
    this.sdk.dispose();
    this.relay.dispose();
  }

  // --- Image upload: Blossom (encrypted blob) ---

  private async handleBlossomImage(msg: UploadImageBlossomMessage): Promise<void> {
    this.log(`[Codedeck] Blossom image: downloading ${msg.url} (${msg.sizeBytes} bytes)`);

    try {
      const response = await fetch(msg.url);
      if (!response.ok) {
        throw new Error(`Blossom download failed: ${response.status} ${response.statusText}`);
      }
      const encryptedBytes = new Uint8Array(await response.arrayBuffer());

      const hashBuffer = crypto.createHash('sha256').update(encryptedBytes).digest();
      const hashHex = hashBuffer.toString('hex');
      if (hashHex !== msg.hash) {
        throw new Error(`Hash mismatch: expected ${msg.hash}, got ${hashHex}`);
      }

      const key = Buffer.from(msg.key, 'hex');
      const iv = Buffer.from(msg.iv, 'hex');
      const authTag = encryptedBytes.slice(-16);
      const ciphertext = encryptedBytes.slice(0, -16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      const uploadsDir = path.join(this.workspaceCwd || '.', '.codedeck', 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      const safeName = msg.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = msg.mimeType === 'image/png' ? '.png' : '.jpg';
      const timestamp = Date.now();
      const hasExt = safeName.toLowerCase().endsWith(ext);
      const finalName = `${timestamp}-${safeName}${hasExt ? '' : ext}`;
      const filePath = path.join(uploadsDir, finalName);

      fs.writeFileSync(filePath, decrypted);
      this.log(`[Codedeck] Blossom image saved: ${filePath} (${decrypted.length} bytes)`);

      const userText = msg.text.trim();
      const terminalText = userText
        ? `${userText}\n\n[Attached image: ${filePath} — use the Read tool to view it]`
        : `Please examine this image: ${filePath}`;

      const sent = this.sdk.sendInput(msg.sessionId, terminalText);
      if (!sent) {
        this.log(`[Codedeck] No SDK session for image upload to ${msg.sessionId}`);
      }
    } catch (err) {
      this.log(`[Codedeck] Blossom image download/decrypt failed: ${err}`);
    }
  }

  // --- Image upload chunk assembly (legacy) ---

  private handleImageChunk(
    sessionId: string, uploadId: string, filename: string, mimeType: string,
    base64Data: string, text: string, chunkIndex: number, totalChunks: number,
  ): void {
    let tracker = this.imageChunks.get(uploadId);

    if (!tracker) {
      const timeoutId = setTimeout(() => {
        const t = this.imageChunks.get(uploadId);
        this.log(`[Codedeck] Image upload ${uploadId} timed out (received ${t?.received.size ?? 0}/${totalChunks} chunks)`);
        this.imageChunks.delete(uploadId);
      }, BridgeCore.IMAGE_ASSEMBLY_TIMEOUT_MS);

      tracker = { sessionId, filename, mimeType, text, totalChunks, received: new Map(), timeoutId };
      this.imageChunks.set(uploadId, tracker);
    }

    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
      this.log(`[Codedeck] Image chunk ${chunkIndex} out of range [0, ${totalChunks}) — skipping`);
      return;
    }
    tracker.received.set(chunkIndex, base64Data);
    if (chunkIndex === 0 && text) {
      tracker.text = text;
    }

    this.log(`[Codedeck] Image chunk ${chunkIndex + 1}/${totalChunks} for upload ${uploadId}`);

    if (tracker.received.size >= totalChunks) {
      clearTimeout(tracker.timeoutId);
      this.imageChunks.delete(uploadId);
      this.assembleAndWriteImage(tracker);
    }
  }

  private async assembleAndWriteImage(tracker: ImageUploadTracker): Promise<void> {
    const parts: string[] = [];
    for (let i = 0; i < tracker.totalChunks; i++) {
      const chunk = tracker.received.get(i);
      if (chunk === undefined) {
        this.log(`[Codedeck] Missing chunk ${i} for image upload — aborting`);
        return;
      }
      parts.push(chunk);
    }
    const fullBase64 = parts.join('');

    const uploadsDir = path.join(this.workspaceCwd || '.', '.codedeck', 'uploads');
    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
    } catch (err) {
      this.log(`[Codedeck] Failed to create uploads dir: ${err}`);
      return;
    }

    const safeName = tracker.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = tracker.mimeType === 'image/png' ? '.png' : '.jpg';
    const timestamp = Date.now();
    const hasExt = safeName.toLowerCase().endsWith(ext);
    const finalName = `${timestamp}-${safeName}${hasExt ? '' : ext}`;
    const filePath = path.join(uploadsDir, finalName);

    try {
      const buffer = Buffer.from(fullBase64, 'base64');
      fs.writeFileSync(filePath, buffer);
      this.log(`[Codedeck] Image saved: ${filePath} (${buffer.length} bytes)`);
    } catch (err) {
      this.log(`[Codedeck] Failed to write image: ${err}`);
      return;
    }

    const userText = tracker.text.trim();
    const terminalText = userText
      ? `${userText}\n\n[Attached image: ${filePath} — use the Read tool to view it]`
      : `Please examine this image: ${filePath}`;

    const sent = this.sdk.sendInput(tracker.sessionId, terminalText);
    if (!sent) {
      this.log(`[Codedeck] No SDK session for image upload to ${tracker.sessionId}`);
    }
  }
}
