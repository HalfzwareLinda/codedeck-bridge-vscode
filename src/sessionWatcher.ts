/**
 * Watch Claude Code session JSONL files for changes.
 *
 * Monitors ~/.claude/projects/ for JSONL files and emits new lines
 * as they're appended. Uses a tail-f approach: tracks file offsets
 * and only reads new content on each change event.
 *
 * Also maintains a history buffer per session for catch-up requests.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseJsonlLine, extractSessionMeta, extractFirstUserMessage, resolveProjectFromCwd, extractPermissionMode, toolNeedsPermission, shouldAutoApproveInPlanMode } from './jsonlParser';
import type { OutputEntry, RemoteSessionInfo } from './types';

const MAX_HISTORY_PER_SESSION = 500;
const MAX_TOTAL_HISTORY_ENTRIES = 10_000;
/** Sessions with no output in this window are candidates for history eviction. */
const HISTORY_EVICT_IDLE_MS = 30 * 60 * 1000; // 30 minutes
/** If an auto-approve keypress hasn't been answered in this time, skip it and try the next. */
const AUTO_APPROVE_STALE_MS = 30_000;

interface PendingAutoApprove {
  toolUseId: string;
  toolName: string;
  enqueuedAt: number;
}

/**
 * Queues auto-approve keypresses per session so they're sent one at a time.
 *
 * When multiple tool_use entries appear in the same JSONL batch (parallel tool
 * calls), sending all keypresses at once causes all but the first to be lost —
 * Claude Code shows permission prompts sequentially and needs time between them.
 *
 * The queue sends the first keypress immediately, then waits for the tool_result
 * to appear in the JSONL (via the next poll cycle) before sending the next.
 */
class AutoApproveQueue {
  private queues: Map<string, PendingAutoApprove[]> = new Map();
  /** The toolUseId we sent a keypress for and are waiting to see resolved. */
  private inflight: Map<string, string> = new Map();

  /**
   * Add a tool to the queue. Returns `{ immediate: true }` if nothing is
   * in-flight and the caller should fire the keypress now.
   */
  enqueue(sessionId: string, toolUseId: string, toolName: string): { immediate: boolean } {
    if (!this.inflight.has(sessionId)) {
      this.inflight.set(sessionId, toolUseId);
      return { immediate: true };
    }
    let q = this.queues.get(sessionId);
    if (!q) { q = []; this.queues.set(sessionId, q); }
    q.push({ toolUseId, toolName, enqueuedAt: Date.now() });
    return { immediate: false };
  }

  /**
   * Called after resolvedToolIds is updated. If the in-flight tool is now
   * resolved, pops the next queued item and returns it (caller fires keypress).
   */
  drain(sessionId: string, resolvedIds: Set<string>): PendingAutoApprove | null {
    const inflightId = this.inflight.get(sessionId);
    if (!inflightId) { return null; }

    const resolved = resolvedIds.has(inflightId);
    const stale = !resolved && this.isStale(sessionId);

    if (!resolved && !stale) { return null; }

    if (stale) {
      console.log(`[Codedeck] Auto-approve stale: ${inflightId} for ${sessionId} — skipping`);
    }

    // In-flight is done (or stale) — pop next
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) {
      this.inflight.delete(sessionId);
      return null;
    }
    const next = q.shift()!;
    if (q.length === 0) { this.queues.delete(sessionId); }
    this.inflight.set(sessionId, next.toolUseId);
    return next;
  }

  private isStale(sessionId: string): boolean {
    const q = this.queues.get(sessionId);
    // Check the oldest queued item's timestamp as a proxy
    if (q && q.length > 0 && Date.now() - q[0].enqueuedAt > AUTO_APPROVE_STALE_MS) {
      return true;
    }
    return false;
  }

  clear(sessionId: string): void {
    this.queues.delete(sessionId);
    this.inflight.delete(sessionId);
  }

  clearAll(): void {
    this.queues.clear();
    this.inflight.clear();
  }
}

export interface SessionWatcherEvents {
  onOutput: (sessionId: string, entries: Array<{ seq: number; entry: OutputEntry }>) => void;
  onSessionListChanged: (sessions: RemoteSessionInfo[]) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  onExistingSession?: (sessionId: string, cwd: string) => void;
  /** Fired when a JSONL user entry reveals the session's actual permissionMode. */
  onPermissionModeChanged?: (sessionId: string, mode: string) => void;
  /** Fired when a tool permission should be auto-approved (e.g. read-only tools in plan mode, or bypass mode). */
  onAutoApprovePermission?: (sessionId: string, toolUseId: string, toolName: string) => void;
  /** Check if a session is in phone-side bypass mode (auto-approve all permission prompts). */
  isBypassSession?: (sessionId: string) => boolean;
  /** Get the bridge's authoritative tracked mode (set optimistically on mode change). */
  getTrackedMode?: (sessionId: string) => string | undefined;
}

export class SessionWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | null = null;
  private fileOffsets: Map<string, number> = new Map();
  private sessionMeta: Map<string, { sessionId: string; slug: string; cwd: string; title: string | null; inferredProject?: string }> = new Map();
  private sessionHistory: Map<string, Array<{ seq: number; entry: OutputEntry }>> = new Map();
  private seqCounters: Map<string, number> = new Map();
  private permissionModes: Map<string, string> = new Map();
  /** Incrementally maintained set of tool_use_ids that have a tool_result per session. */
  private resolvedToolIds: Map<string, Set<string>> = new Map();
  /** Last time output was emitted per session — for LRU history eviction. */
  private lastOutputTime: Map<string, number> = new Map();
  private events: SessionWatcherEvents;
  private claudeDir: string;
  private workspaceCwd: string | undefined;
  private pollInterval: NodeJS.Timeout | null = null;
  /** Standalone interval for LRU history eviction (independent of poll cadence). */
  private evictInterval: NodeJS.Timeout | null = null;
  /** Guard against concurrent readNewLines for the same file. */
  private readingFiles = new Set<string>();
  private autoApproveQueue = new AutoApproveQueue();
  private emitDebounceTimer: NodeJS.Timeout | null = null;
  private pollCount = 0;
  private static readonly NEW_FILE_SCAN_EVERY_N_POLLS = 3; // scan for new files every 3rd poll (every 6s)

  constructor(events: SessionWatcherEvents, workspaceCwd?: string) {
    this.events = events;
    this.claudeDir = path.join(os.homedir(), '.claude', 'projects');
    this.workspaceCwd = workspaceCwd;
  }

  start(): void {
    if (!fs.existsSync(this.claudeDir)) {
      console.log(`[Codedeck] Claude projects dir not found: ${this.claudeDir}`);
      return;
    }

    // Initial scan of all existing sessions
    this.scanAllSessions();

    // Watch for JSONL file changes using vscode FileSystemWatcher
    const pattern = new vscode.RelativePattern(this.claudeDir, '**/*.jsonl');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    this.watcher.onDidChange(uri => this.onFileChanged(uri.fsPath));
    this.watcher.onDidCreate(uri => this.onFileCreated(uri.fsPath));
    this.watcher.onDidDelete(uri => this.onFileDeleted(uri.fsPath));

    // Also poll every 2 seconds for changes that FileSystemWatcher might miss
    // (some systems don't reliably fire events for appended content)
    this.pollInterval = setInterval(() => this.pollActiveFiles(), 2000);

    // Standalone LRU history eviction — runs every 5 minutes, independent of polling
    this.evictInterval = setInterval(() => this.evictIdleHistory(), 5 * 60 * 1000);

    console.log(`[Codedeck] Watching ${this.claudeDir} for session changes`);
  }

  /**
   * Get buffered history entries for a session, optionally filtered by seq.
   */
  getHistory(sessionId: string, afterSeq?: number): Array<{ seq: number; entry: OutputEntry }> {
    const history = this.sessionHistory.get(sessionId) ?? [];
    if (afterSeq !== undefined && afterSeq > 0) {
      return history.filter(h => h.seq > afterSeq);
    }
    return history;
  }

  /**
   * Load full session history from JSONL file for catch-up requests.
   * Re-reads the file from the beginning, parsing all lines.
   */
  loadFullHistory(sessionId: string): Array<{ seq: number; entry: OutputEntry }> {
    // Check buffered history first
    const buffered = this.sessionHistory.get(sessionId);
    if (buffered && buffered.length > 0) {
      return buffered;
    }

    // Find the file for this session
    let filePath: string | null = null;
    for (const [fp, meta] of this.sessionMeta) {
      if (meta.sessionId === sessionId) { filePath = fp; break; }
    }
    if (!filePath) { return []; }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const entries: Array<{ seq: number; entry: OutputEntry }> = [];
      let seq = 0;

      // Parse all lines first, then collect resolved tool IDs to suppress
      // permission cards for tools that already have results (all of them in history).
      let currentMode = this.permissionModes.get(sessionId) ?? 'default';
      const allParsed: OutputEntry[] = [];
      for (const line of lines) {
        if (!line.trim()) { continue; }
        const mode = extractPermissionMode(line);
        if (mode) { currentMode = mode; }
        allParsed.push(...parseJsonlLine(line));
      }
      this.permissionModes.set(sessionId, currentMode);

      // Build and cache the resolvedToolIds set so readNewLines can use it incrementally
      let resolved = this.resolvedToolIds.get(sessionId);
      if (!resolved) {
        resolved = new Set();
        this.resolvedToolIds.set(sessionId, resolved);
      }
      for (const entry of allParsed) {
        if (entry.entryType === 'tool_result') {
          const id = entry.metadata?.tool_use_id as string | undefined;
          if (id) { resolved.add(id); }
        }
      }

      const currentModeForHistory = this.events.getTrackedMode?.(sessionId)
        ?? this.permissionModes.get(sessionId)
        ?? 'default';
      const withPermissions = this.injectPermissionRequests(allParsed, resolved, sessionId, currentModeForHistory);
      for (const entry of withPermissions) {
        seq++;
        entries.push({ seq, entry });
      }

      // Cap to max history
      const capped = entries.length > MAX_HISTORY_PER_SESSION
        ? entries.slice(-MAX_HISTORY_PER_SESSION)
        : entries;

      // Cache for future requests
      this.sessionHistory.set(sessionId, capped);
      this.seqCounters.set(sessionId, seq);

      return capped;
    } catch {
      return [];
    }
  }

  /**
   * Get total history entry count for a session.
   */
  getHistoryCount(sessionId: string): number {
    return this.sessionHistory.get(sessionId)?.length ?? 0;
  }

  private scanAllSessions(): void {
    try {
      const projectDirs = fs.readdirSync(this.claudeDir);
      for (const dir of projectDirs) {
        const projectPath = path.join(this.claudeDir, dir);
        const stat = fs.statSync(projectPath);
        if (!stat.isDirectory()) { continue; }

        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(projectPath, file);
          this.indexSession(filePath);
        }
      }

      // Derive seq counters from file content so seq continues across restarts
      for (const [, meta] of this.sessionMeta) {
        if (!this.seqCounters.has(meta.sessionId)) {
          this.loadFullHistory(meta.sessionId);
        }
      }

      // Notify about existing sessions so TerminalRegistry can map them
      for (const [, meta] of this.sessionMeta) {
        this.events.onExistingSession?.(meta.sessionId, meta.cwd);
      }

      this.emitSessionList();
    } catch (err) {
      console.error('[Codedeck] Error scanning sessions:', err);
    }
  }

  /**
   * Read complete JSONL lines from a file, skipping over huge lines
   * (e.g. multi-MB file-history-snapshot) without loading them into memory.
   * Returns up to `maxLines` complete non-empty lines.
   */
  private readFirstLines(filePath: string, maxLines: number): string[] {
    const CHUNK_SIZE = 8192;
    const MAX_LINE_LEN = 50_000; // skip lines longer than this (snapshots)
    const lines: string[] = [];
    let offset = 0;
    let partial = '';

    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const fileSize = stat.size;

      while (lines.length < maxLines && offset < fileSize) {
        const buf = Buffer.alloc(CHUNK_SIZE);
        const bytesRead = fs.readSync(fd, buf, 0, CHUNK_SIZE, offset);
        if (bytesRead === 0) { break; }
        offset += bytesRead;

        partial += buf.toString('utf8', 0, bytesRead);

        // Extract complete lines (ending with \n)
        let nlIdx: number;
        while ((nlIdx = partial.indexOf('\n')) !== -1) {
          const line = partial.slice(0, nlIdx).trim();
          partial = partial.slice(nlIdx + 1);

          if (!line) { continue; }
          if (line.length > MAX_LINE_LEN) { continue; } // skip huge lines
          lines.push(line);
          if (lines.length >= maxLines) { break; }
        }

        // If partial is growing huge (stuck in a massive line), skip ahead
        if (partial.length > MAX_LINE_LEN) {
          // Find the next newline in the file by scanning ahead
          const skipBuf = Buffer.alloc(CHUNK_SIZE);
          while (offset < fileSize) {
            const n = fs.readSync(fd, skipBuf, 0, CHUNK_SIZE, offset);
            if (n === 0) { break; }
            const skipStr = skipBuf.toString('utf8', 0, n);
            const skipNl = skipStr.indexOf('\n');
            if (skipNl !== -1) {
              offset += skipNl + 1;
              partial = '';
              break;
            }
            offset += n;
          }
          partial = '';
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    return lines;
  }

  private indexSession(filePath: string): void {
    // Skip subagent sessions
    if (filePath.includes('/subagents/')) { return; }

    try {
      const lines = this.readFirstLines(filePath, 20);
      const meta = extractSessionMeta(lines, this.workspaceCwd, filePath);

      if (meta) {
        const title = extractFirstUserMessage(lines);
        this.sessionMeta.set(filePath, { ...meta, title });
        // Set offset to current file size (don't replay old content)
        const stat = fs.statSync(filePath);
        this.fileOffsets.set(filePath, stat.size);
      }
    } catch (err) {
      console.log(`[Codedeck] indexSession failed for ${path.basename(filePath)}: ${err}`);
    }
  }

  private onFileCreated(filePath: string): void {
    if (!filePath.endsWith('.jsonl')) { return; }
    if (filePath.includes('/subagents/')) { return; }

    console.log(`[Codedeck] FileSystemWatcher onFileCreated: ${path.basename(filePath)}`);

    // New session file — index it and start from beginning.
    // With fallbackCwd, indexSession succeeds even if only queue-operation
    // lines exist (no cwd yet). If file is truly empty, the 2s poll loop
    // in pollActiveFiles will pick it up via readNewLines's retry path.
    this.fileOffsets.set(filePath, 0);
    this.indexSession(filePath);
    this.emitSessionList();

    const meta = this.sessionMeta.get(filePath);
    if (meta) {
      console.log(`[Codedeck] onFileCreated: indexed ${meta.sessionId}, firing onNewSession`);
      this.events.onNewSession?.(meta.sessionId, meta.cwd);
    } else {
      console.log(`[Codedeck] onFileCreated: indexing failed for ${path.basename(filePath)} — will retry via poll`);
    }

    this.readNewLines(filePath);
  }

  private onFileChanged(filePath: string): void {
    if (!filePath.endsWith('.jsonl')) { return; }
    if (filePath.includes('/subagents/')) { return; }

    console.log(`[Codedeck] FileSystemWatcher onFileChanged: ${path.basename(filePath)}`);
    this.readNewLines(filePath);
  }

  private onFileDeleted(filePath: string): void {
    this.fileOffsets.delete(filePath);
    const meta = this.sessionMeta.get(filePath);
    if (meta) {
      this.sessionHistory.delete(meta.sessionId);
      this.seqCounters.delete(meta.sessionId);
      this.autoApproveQueue.clear(meta.sessionId);
    }
    this.sessionMeta.delete(filePath);
    this.emitSessionList();
  }

  private readNewLines(filePath: string): void {
    // Prevent concurrent reads of the same file (onFileCreated vs pollActiveFiles race)
    if (this.readingFiles.has(filePath)) { return; }
    this.readingFiles.add(filePath);
    try {
      // Open first, then fstat — avoids TOCTOU race where file is deleted between stat and open
      let fd: number;
      try {
        fd = fs.openSync(filePath, 'r');
      } catch (err: unknown) {
        // File deleted — clean up stale offset entry
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.onFileDeleted(filePath);
        }
        return;
      }

      let chunk: string;
      try {
        const stat = fs.fstatSync(fd);
        const offset = this.fileOffsets.get(filePath) ?? 0;

        if (stat.size <= offset) { return; }

        // Read only the new bytes
        const newSize = stat.size - offset;
        const buf = Buffer.alloc(newSize);
        fs.readSync(fd, buf, 0, newSize, offset);

        this.fileOffsets.set(filePath, stat.size);
        chunk = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }

      if (!chunk) { return; }
      const lines = chunk.split('\n');

      // If we don't have meta for this file yet, try to extract it
      if (!this.sessionMeta.has(filePath)) {
        const meta = extractSessionMeta(lines, this.workspaceCwd, filePath);
        if (meta) {
          const title = extractFirstUserMessage(lines) ?? extractFirstUserMessage(this.readFirstLines(filePath, 20));
          this.sessionMeta.set(filePath, { ...meta, title });
          this.emitSessionList();
        }
      } else {
        // Self-correct: update cwd if a line with the real cwd appears
        // (initial indexing may have used the workspace fallback)
        this.maybeUpdateCwd(filePath, lines);

        // Back-fill title if still null (phone-spawned sessions are indexed before
        // the user types their first message, so title is initially null)
        const existingMeta = this.sessionMeta.get(filePath);
        if (existingMeta && !existingMeta.title) {
          const title = extractFirstUserMessage(lines);
          if (title) {
            existingMeta.title = title;
            this.emitSessionList();
          }
        }
      }

      const meta = this.sessionMeta.get(filePath);
      if (!meta) { return; }

      // Two-pass approach: parse all lines first, then inject permission_request
      // entries only for tool_use calls whose tool_result is NOT already in the
      // same batch. This avoids flashing a permission card for auto-approved tools.

      // Pass 1: parse all lines, track permissionMode
      const batchEntries: OutputEntry[] = [];
      for (const line of lines) {
        if (!line.trim()) { continue; }

        const mode = extractPermissionMode(line);
        if (mode) {
          this.permissionModes.set(meta.sessionId, mode);
          this.events.onPermissionModeChanged?.(meta.sessionId, mode);
          // If mode changed away from plan/bypass, flush the auto-approve queue
          // so remaining tools become normal permission cards on the next cycle.
          if (mode !== 'plan' && mode !== 'bypassPermissions') {
            this.autoApproveQueue.clear(meta.sessionId);
          }
        }

        const entries = parseJsonlLine(line);
        batchEntries.push(...entries);
      }

      // Ensure persistent resolvedToolIds set exists for this session
      let resolved = this.resolvedToolIds.get(meta.sessionId);
      if (!resolved) {
        resolved = new Set();
        this.resolvedToolIds.set(meta.sessionId, resolved);
      }

      // Pass 2: inject permission_request entries. injectPermissionRequests() does
      // its own same-batch detection: if a tool_use and its tool_result are both
      // in this batch, the tool was auto-approved and no card is injected.
      const currentMode = this.events.getTrackedMode?.(meta.sessionId)
        ?? this.permissionModes.get(meta.sessionId)
        ?? 'default';
      const withPermissions = this.injectPermissionRequests(batchEntries, resolved, meta.sessionId, currentMode);

      // NOW update resolvedToolIds with this batch's tool_results (for future batches)
      for (const entry of batchEntries) {
        if (entry.entryType === 'tool_result') {
          const id = entry.metadata?.tool_use_id as string | undefined;
          if (id) { resolved.add(id); }
        }
      }

      // Drain the auto-approve queue: if the in-flight tool's result just arrived,
      // fire the keypress for the next queued tool.
      const nextApproval = this.autoApproveQueue.drain(meta.sessionId, resolved);
      if (nextApproval) {
        console.log(`[Codedeck] Auto-approve drained: ${nextApproval.toolName} for ${meta.sessionId} (id=${nextApproval.toolUseId})`);
        this.events.onAutoApprovePermission?.(meta.sessionId, nextApproval.toolUseId, nextApproval.toolName);
      }

      const seqEntries: Array<{ seq: number; entry: OutputEntry }> = [];
      for (const entry of withPermissions) {
        const seq = (this.seqCounters.get(meta.sessionId) ?? 0) + 1;
        this.seqCounters.set(meta.sessionId, seq);

        let history = this.sessionHistory.get(meta.sessionId);
        if (!history) {
          history = [];
          this.sessionHistory.set(meta.sessionId, history);
        }
        history.push({ seq, entry });

        // Cap history buffer and prune resolvedToolIds to match
        if (history.length > MAX_HISTORY_PER_SESSION) {
          history.splice(0, history.length - MAX_HISTORY_PER_SESSION);
          // Rebuild resolvedToolIds from surviving entries
          const resolved = this.resolvedToolIds.get(meta.sessionId);
          if (resolved && resolved.size > MAX_HISTORY_PER_SESSION) {
            const newResolved = new Set<string>();
            for (const h of history) {
              if (h.entry.entryType === 'tool_result') {
                const id = h.entry.metadata?.tool_use_id as string | undefined;
                if (id) newResolved.add(id);
              }
            }
            this.resolvedToolIds.set(meta.sessionId, newResolved);
          }
        }

        seqEntries.push({ seq, entry });
      }

      if (seqEntries.length > 0) {
        this.lastOutputTime.set(meta.sessionId, Date.now());
        this.events.onOutput(meta.sessionId, seqEntries);
      }

      // Try to infer project from tool_use paths if still at workspace root
      if (!meta.inferredProject && this.workspaceCwd) {
        const wsNorm = this.workspaceCwd.replace(/\/+$/, '');
        if (meta.cwd.replace(/\/+$/, '') === wsNorm) {
          const inferred = this.inferProjectFromToolUse(filePath, wsNorm);
          if (inferred) {
            meta.inferredProject = inferred;
            this.emitSessionList();
          }
        }
      }
    } catch (err) {
      console.warn(`[Codedeck] readNewLines failed for ${path.basename(filePath)}:`, err);
    } finally {
      this.readingFiles.delete(filePath);
    }
  }

  /**
   * Update the cwd for a session once the real cwd appears in JSONL data.
   * Called when we initially used the workspace fallback cwd and later
   * find the real cwd in a user/assistant line.
   */
  private maybeUpdateCwd(filePath: string, lines: string[]): void {
    const existing = this.sessionMeta.get(filePath);
    if (!existing) { return; }

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.sessionId === existing.sessionId && parsed.cwd && parsed.cwd !== existing.cwd) {
          existing.cwd = parsed.cwd;
          existing.inferredProject = undefined;
          // Also update title if we didn't have one yet
          if (!existing.title) {
            const title = extractFirstUserMessage([line]);
            if (title) { existing.title = title; }
          }
          this.emitSessionList();
          return;
        }
      } catch { continue; }
    }
  }

  /**
   * For each tool_use entry that might need permission, append a
   * permission_request system entry right after it.
   *
   * Uses same-batch detection: if a tool_use and its tool_result both
   * appear in the same batch, the tool was auto-approved — no permission
   * card needed. Only injects cards for tool_use entries that have no
   * matching tool_result in the current batch (i.e. Claude Code is
   * blocked waiting for user approval).
   *
   * `resolvedIds` contains tool_use_ids from previous batches that already
   * have a matching tool_result — these are completed and should not
   * generate a permission card on the phone.
   *
   * In plan mode, read-only tools are auto-approved by firing
   * `onAutoApprovePermission` instead of injecting a permission card.
   */
  private injectPermissionRequests(
    entries: OutputEntry[],
    resolvedIds: Set<string> = new Set(),
    sessionId?: string,
    permissionMode?: string,
  ): OutputEntry[] {
    // Pre-scan: collect tool_use_ids that have a tool_result in THIS batch.
    // If both arrive in the same 2s poll window, the tool was auto-approved.
    const batchResolvedIds = new Set<string>();
    for (const entry of entries) {
      if (entry.entryType === 'tool_result') {
        const id = entry.metadata?.tool_use_id as string | undefined;
        if (id) { batchResolvedIds.add(id); }
      }
    }

    const result: OutputEntry[] = [];
    for (const entry of entries) {
      result.push(entry);
      if (entry.entryType === 'tool_use') {
        const toolName = (entry.metadata?.tool_name as string) ?? '';
        const toolUseId = (entry.metadata?.tool_use_id as string) ?? '';
        if (toolName && toolNeedsPermission(toolName)
            && !resolvedIds.has(toolUseId)
            && !batchResolvedIds.has(toolUseId)) {
          // In bypass mode, auto-approve ALL tools
          if (sessionId && this.events.isBypassSession?.(sessionId)) {
            const { immediate } = this.autoApproveQueue.enqueue(sessionId, toolUseId, toolName);
            if (immediate) {
              console.log(`[Codedeck] Auto-approving ${toolName} in bypass mode (id=${toolUseId})`);
              this.events.onAutoApprovePermission?.(sessionId, toolUseId, toolName);
            } else {
              console.log(`[Codedeck] Auto-approve queued: ${toolName} in bypass mode (id=${toolUseId})`);
            }
            continue;
          }
          // In plan mode, auto-approve read-only tools instead of prompting
          if (permissionMode === 'plan' && shouldAutoApproveInPlanMode(toolName) && sessionId) {
            const { immediate } = this.autoApproveQueue.enqueue(sessionId, toolUseId, toolName);
            if (immediate) {
              console.log(`[Codedeck] Auto-approving ${toolName} in plan mode (id=${toolUseId})`);
              this.events.onAutoApprovePermission?.(sessionId, toolUseId, toolName);
            } else {
              console.log(`[Codedeck] Auto-approve queued: ${toolName} in plan mode (id=${toolUseId})`);
            }
            // Don't inject permission_request — phone won't see the prompt
            continue;
          }
          console.log(`[Codedeck] Injected permission_request for ${toolName} (id=${toolUseId})`);
          result.push({
            entryType: 'system',
            content: entry.content, // e.g. "Bash: git status"
            timestamp: entry.timestamp,
            metadata: {
              special: 'permission_request',
              tool_name: toolName,
              tool_use_id: entry.metadata?.tool_use_id,
              tool_input: entry.metadata?.tool_input,
            },
          });
        } else if (toolName && toolNeedsPermission(toolName)) {
          console.log(`[Codedeck] Suppressed permission_request for ${toolName} (id=${toolUseId}, already resolved)`);
        }
      }
    }
    return result;
  }

  /** Evict history from idle sessions when total entries exceed global cap. */
  private evictIdleHistory(): void {
    let total = 0;
    for (const entries of this.sessionHistory.values()) { total += entries.length; }
    if (total <= MAX_TOTAL_HISTORY_ENTRIES) { return; }

    const now = Date.now();
    // Collect sessions sorted by last output time (oldest first)
    const candidates: Array<{ sessionId: string; lastOutput: number; count: number }> = [];
    for (const [sessionId, entries] of this.sessionHistory) {
      const lastOutput = this.lastOutputTime.get(sessionId) ?? 0;
      if (now - lastOutput > HISTORY_EVICT_IDLE_MS) {
        candidates.push({ sessionId, lastOutput, count: entries.length });
      }
    }
    candidates.sort((a, b) => a.lastOutput - b.lastOutput);

    for (const { sessionId } of candidates) {
      if (total <= MAX_TOTAL_HISTORY_ENTRIES) { break; }
      const entries = this.sessionHistory.get(sessionId);
      if (entries) {
        total -= entries.length;
        this.sessionHistory.delete(sessionId);
        console.log(`[Codedeck] Evicted history for idle session ${sessionId} (${entries.length} entries)`);
      }
    }
  }

  /** Remove sessionMeta entries for files that no longer exist on disk (Fix #13). */
  private pruneDeletedSessions(): void {
    for (const filePath of [...this.sessionMeta.keys()]) {
      if (!fs.existsSync(filePath)) {
        console.log(`[Codedeck] Pruning deleted session file: ${path.basename(filePath)}`);
        this.onFileDeleted(filePath);
      }
    }
  }

  private pollActiveFiles(): void {
    this.pollCount++;
    if (this.pollCount % SessionWatcher.NEW_FILE_SCAN_EVERY_N_POLLS === 0) {
      this.scanForNewFiles();
      // Prune deleted sessions every 6th scan (~36s)
      if (this.pollCount % (SessionWatcher.NEW_FILE_SCAN_EVERY_N_POLLS * 6) === 0) {
        this.pruneDeletedSessions();
      }
    }

    for (const filePath of [...this.fileOffsets.keys()]) {
      try {
        const stat = fs.statSync(filePath);
        const offset = this.fileOffsets.get(filePath) ?? 0;

        // Re-attempt indexing for files we track but never got metadata for
        // (happens when onFileCreated fires on an empty file)
        if (!this.sessionMeta.has(filePath) && stat.size > 0) {
          this.indexSession(filePath);
          if (this.sessionMeta.has(filePath)) {
            this.emitSessionList();
            const meta = this.sessionMeta.get(filePath)!;
            this.events.onNewSession?.(meta.sessionId, meta.cwd);
          }
        }

        // Back-fill title for sessions indexed before the first user message
        if (this.sessionMeta.has(filePath)) {
          const meta = this.sessionMeta.get(filePath)!;
          if (!meta.title && stat.size > 0) {
            const lines = this.readFirstLines(filePath, 40);
            const title = extractFirstUserMessage(lines);
            if (title) {
              meta.title = title;
              this.emitSessionList();
            }
          }
        }

        if (stat.size > offset) {
          this.readNewLines(filePath);
        }
      } catch {
        // File may have been deleted — clean up all maps (mirror onFileDeleted)
        const meta = this.sessionMeta.get(filePath);
        if (meta) {
          this.sessionHistory.delete(meta.sessionId);
          this.seqCounters.delete(meta.sessionId);
        }
        this.fileOffsets.delete(filePath);
        this.sessionMeta.delete(filePath);
        this.emitSessionList();
      }
    }
  }

  /**
   * Infer the project subdirectory from tool_use file paths in a session JSONL.
   * Scans the first 50 lines for file_path/path inputs that reference a
   * subdirectory under the workspace root. Returns the most-referenced one.
   */
  private inferProjectFromToolUse(filePath: string, wsNorm: string): string | null {
    try {
      const lines = this.readFirstLines(filePath, 50);
      const counts = new Map<string, number>();
      const prefix = wsNorm + '/';

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type !== 'assistant') { continue; }
          const content = parsed.message?.content;
          if (!Array.isArray(content)) { continue; }

          for (const block of content) {
            if (block.type !== 'tool_use') { continue; }
            const input = block.input as Record<string, unknown>;

            // Check file_path (Read/Write/Edit) and path (Glob/Grep)
            for (const key of ['file_path', 'path']) {
              const val = typeof input[key] === 'string' ? input[key] as string : '';
              if (val.startsWith(prefix)) {
                const seg = val.slice(prefix.length).split('/')[0];
                if (seg) { counts.set(seg, (counts.get(seg) ?? 0) + 1); }
              }
            }

            // Scan Bash command strings for workspace subpaths
            if (block.name === 'Bash' && typeof input.command === 'string') {
              let idx = 0;
              while ((idx = (input.command as string).indexOf(prefix, idx)) !== -1) {
                const after = (input.command as string).slice(idx + prefix.length);
                const seg = after.split(/[\s/'"`]/)[0];
                if (seg) { counts.set(seg, (counts.get(seg) ?? 0) + 1); }
                idx += prefix.length;
              }
            }
          }
        } catch { continue; }
      }

      if (counts.size === 0) { return null; }

      let best = '';
      let bestCount = 0;
      for (const [seg, count] of counts) {
        if (count > bestCount) { best = seg; bestCount = count; }
      }
      return best || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve the display project name for a session.
   * Tries cwd-based extraction first, then infers from tool_use file paths.
   */
  private resolveProjectName(meta: { cwd: string; inferredProject?: string }, filePath: string): string {
    const resolved = resolveProjectFromCwd(meta.cwd, this.workspaceCwd);
    if (resolved !== null) { return resolved; }

    // cwd is the workspace root — use cached inference or try now
    if (meta.inferredProject) { return meta.inferredProject; }

    if (this.workspaceCwd) {
      const wsNorm = this.workspaceCwd.replace(/\/+$/, '');
      const inferred = this.inferProjectFromToolUse(filePath, wsNorm);
      if (inferred) {
        const cached = this.sessionMeta.get(filePath);
        if (cached) { cached.inferredProject = inferred; }
        return inferred;
      }
    }

    // Final fallback
    return path.basename(meta.cwd) || meta.cwd;
  }

  /**
   * Force a full re-scan of session files from disk.
   * Called on refresh-sessions requests to pick up changes that
   * the FileSystemWatcher or poll loop may have missed.
   */
  rescanSessions(): void {
    this.scanAllSessions();
  }

  /**
   * Lightweight scan for NEW .jsonl files not yet in fileOffsets.
   * Unlike scanAllSessions(), this only indexes previously-unknown files
   * and fires onNewSession for each one. Fast enough to call every few
   * seconds as a backup when FileSystemWatcher doesn't fire.
   */
  scanForNewFiles(): void {
    try {
      const projectDirs = fs.readdirSync(this.claudeDir);
      for (const dir of projectDirs) {
        const projectPath = path.join(this.claudeDir, dir);
        try {
          const stat = fs.statSync(projectPath);
          if (!stat.isDirectory()) { continue; }
        } catch { continue; }

        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const filePath = path.join(projectPath, file);
          if (filePath.includes('/subagents/')) { continue; }
          if (this.fileOffsets.has(filePath)) { continue; }

          // New file — index from the beginning
          console.log(`[Codedeck] scanForNewFiles discovered: ${file}`);
          this.fileOffsets.set(filePath, 0);
          this.indexSession(filePath);

          const meta = this.sessionMeta.get(filePath);
          if (meta) {
            console.log(`[Codedeck] scanForNewFiles: new session ${meta.sessionId}`);
            this.emitSessionList();
            this.events.onNewSession?.(meta.sessionId, meta.cwd);
            this.readNewLines(filePath);
          }
        }
      }
      // Recovery pass: retry files we track but failed to index (e.g. file was empty on creation)
      for (const filePath of this.fileOffsets.keys()) {
        if (this.sessionMeta.has(filePath)) { continue; }
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 0) {
            this.indexSession(filePath);
            if (this.sessionMeta.has(filePath)) {
              const meta = this.sessionMeta.get(filePath)!;
              console.log(`[Codedeck] scanForNewFiles: recovered half-indexed ${meta.sessionId}`);
              this.emitSessionList();
              this.events.onNewSession?.(meta.sessionId, meta.cwd);
            }
          }
        } catch { /* file may have been deleted */ }
      }
    } catch (err) {
      console.error('[Codedeck] Error scanning for new files:', err);
    }
  }

  getSessions(): RemoteSessionInfo[] {
    const sessions: RemoteSessionInfo[] = [];
    const now = Date.now();
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const MAX_SESSIONS = 15;

    for (const [filePath, meta] of this.sessionMeta) {
      try {
        const stat = fs.statSync(filePath);
        // Skip sessions not modified in the last 7 days
        if (now - stat.mtimeMs > MAX_AGE_MS) { continue; }
        sessions.push({
          id: meta.sessionId,
          slug: meta.slug,
          cwd: meta.cwd,
          lastActivity: stat.mtime.toISOString(),
          lineCount: this.fileOffsets.get(filePath) ?? 0,
          title: meta.title ?? null,
          project: this.resolveProjectName(meta, filePath),
          permissionMode: (this.permissionModes.get(meta.sessionId) as RemoteSessionInfo['permissionMode']) ?? undefined,
        });
      } catch {
        // File gone
      }
    }
    // Deduplicate by sessionId — multiple JSONL files can share the same sessionId
    // (e.g. when Claude Code resumes a session). Keep the most recently modified file.
    const deduped = new Map<string, RemoteSessionInfo>();
    for (const s of sessions) {
      const existing = deduped.get(s.id);
      if (!existing || s.lastActivity > existing.lastActivity) {
        deduped.set(s.id, s);
      }
    }
    const unique = [...deduped.values()];

    // Sort by last activity, most recent first — cap to avoid oversized Nostr events
    unique.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    return unique.slice(0, MAX_SESSIONS);
  }

  /** Get the current permission mode for a session (from JSONL parsing). */
  getPermissionMode(sessionId: string): string | undefined {
    return this.permissionModes.get(sessionId);
  }

  private emitSessionList(): void {
    // Debounce: coalesce rapid-fire calls (e.g. during startup scan) into one publish
    if (this.emitDebounceTimer) { clearTimeout(this.emitDebounceTimer); }
    this.emitDebounceTimer = setTimeout(() => {
      this.emitDebounceTimer = null;
      this.events.onSessionListChanged(this.getSessions());
    }, 500);
  }

  dispose(): void {
    this.autoApproveQueue.clearAll();
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.evictInterval) {
      clearInterval(this.evictInterval);
      this.evictInterval = null;
    }
    if (this.emitDebounceTimer) {
      clearTimeout(this.emitDebounceTimer);
      this.emitDebounceTimer = null;
    }
  }
}
