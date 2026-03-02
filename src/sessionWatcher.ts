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
import { parseJsonlLine, extractSessionMeta, extractFirstUserMessage, resolveProjectFromCwd } from './jsonlParser';
import type { OutputEntry, RemoteSessionInfo } from './types';

const MAX_HISTORY_PER_SESSION = 500;

export interface SessionWatcherEvents {
  onOutput: (sessionId: string, entries: Array<{ seq: number; entry: OutputEntry }>) => void;
  onSessionListChanged: (sessions: RemoteSessionInfo[]) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  onExistingSession?: (sessionId: string, cwd: string) => void;
}

export class SessionWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | null = null;
  private fileOffsets: Map<string, number> = new Map();
  private sessionMeta: Map<string, { sessionId: string; slug: string; cwd: string; title: string | null; inferredProject?: string }> = new Map();
  private sessionHistory: Map<string, Array<{ seq: number; entry: OutputEntry }>> = new Map();
  private seqCounters: Map<string, number> = new Map();
  private events: SessionWatcherEvents;
  private claudeDir: string;
  private workspaceCwd: string | undefined;
  private pollInterval: NodeJS.Timeout | null = null;
  private emitDebounceTimer: NodeJS.Timeout | null = null;
  private pollCount = 0;
  private fastScanInterval: NodeJS.Timeout | null = null;
  private fastScanTimeout: NodeJS.Timeout | null = null;

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

      for (const line of lines) {
        if (!line.trim()) { continue; }
        const parsed = parseJsonlLine(line);
        for (const entry of parsed) {
          seq++;
          entries.push({ seq, entry });
        }
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
    }
    this.sessionMeta.delete(filePath);
    this.emitSessionList();
  }

  private readNewLines(filePath: string): void {
    try {
      const stat = fs.statSync(filePath);
      const offset = this.fileOffsets.get(filePath) ?? 0;

      if (stat.size <= offset) { return; }

      // Read only the new bytes
      const fd = fs.openSync(filePath, 'r');
      const newSize = stat.size - offset;
      const buf = Buffer.alloc(newSize);
      try {
        fs.readSync(fd, buf, 0, newSize, offset);
      } finally {
        fs.closeSync(fd);
      }

      this.fileOffsets.set(filePath, stat.size);

      const chunk = buf.toString('utf8');
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
      }

      const meta = this.sessionMeta.get(filePath);
      if (!meta) { return; }

      // Parse each new line, buffer in history with seq, and emit
      const seqEntries: Array<{ seq: number; entry: OutputEntry }> = [];

      for (const line of lines) {
        if (!line.trim()) { continue; }
        const entries = parseJsonlLine(line);
        for (const entry of entries) {
          const seq = (this.seqCounters.get(meta.sessionId) ?? 0) + 1;
          this.seqCounters.set(meta.sessionId, seq);

          let history = this.sessionHistory.get(meta.sessionId);
          if (!history) {
            history = [];
            this.sessionHistory.set(meta.sessionId, history);
          }
          history.push({ seq, entry });

          // Cap history buffer
          if (history.length > MAX_HISTORY_PER_SESSION) {
            history.splice(0, history.length - MAX_HISTORY_PER_SESSION);
          }

          seqEntries.push({ seq, entry });
        }
      }

      if (seqEntries.length > 0) {
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
    } catch {
      // File may have been deleted between stat and read
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

  private pollActiveFiles(): void {
    this.pollCount++;
    if (this.pollCount % SessionWatcher.NEW_FILE_SCAN_EVERY_N_POLLS === 0) {
      this.scanForNewFiles();
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
        });
      } catch {
        // File gone
      }
    }
    // Sort by last activity, most recent first — cap to avoid oversized Nostr events
    sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    return sessions.slice(0, MAX_SESSIONS);
  }

  /** Return ALL indexed session IDs (no cap). */
  getAllSessionIds(): string[] {
    return [...this.sessionMeta.values()].map(m => m.sessionId);
  }

  /**
   * Find the newest indexed session whose ID is not in `excludeIds`.
   * Searches ALL sessionMeta entries (no 15-cap), so detection works
   * regardless of how many sessions exist.
   */
  findNewSessionNotIn(excludeIds: Set<string>): RemoteSessionInfo | null {
    let newest: { info: RemoteSessionInfo; mtimeMs: number } | null = null;

    for (const [filePath, meta] of this.sessionMeta) {
      if (excludeIds.has(meta.sessionId)) { continue; }
      try {
        const stat = fs.statSync(filePath);
        const info: RemoteSessionInfo = {
          id: meta.sessionId,
          slug: meta.slug,
          cwd: meta.cwd,
          lastActivity: stat.mtime.toISOString(),
          lineCount: this.fileOffsets.get(filePath) ?? 0,
          title: meta.title ?? null,
          project: this.resolveProjectName(meta, filePath),
        };
        if (!newest || stat.mtimeMs > newest.mtimeMs) {
          newest = { info, mtimeMs: stat.mtimeMs };
        }
      } catch {
        // File gone
      }
    }

    return newest?.info ?? null;
  }

  private emitSessionList(): void {
    // Debounce: coalesce rapid-fire calls (e.g. during startup scan) into one publish
    if (this.emitDebounceTimer) { clearTimeout(this.emitDebounceTimer); }
    this.emitDebounceTimer = setTimeout(() => {
      this.emitDebounceTimer = null;
      this.events.onSessionListChanged(this.getSessions());
    }, 500);
  }

  /**
   * Temporarily scan for new files every `intervalMs` (default 1s).
   * Used during pending session creation for rapid detection.
   * Auto-stops after `maxDurationMs` (default 30s).
   */
  startFastScan(intervalMs = 1000, maxDurationMs = 30_000): void {
    if (this.fastScanInterval) { return; } // already running
    console.log(`[Codedeck] Starting fast scan (every ${intervalMs}ms, up to ${maxDurationMs / 1000}s)`);
    this.fastScanInterval = setInterval(() => this.scanForNewFiles(), intervalMs);
    this.fastScanTimeout = setTimeout(() => this.stopFastScan(), maxDurationMs);
  }

  stopFastScan(): void {
    if (this.fastScanInterval) {
      clearInterval(this.fastScanInterval);
      this.fastScanInterval = null;
    }
    if (this.fastScanTimeout) {
      clearTimeout(this.fastScanTimeout);
      this.fastScanTimeout = null;
    }
  }

  dispose(): void {
    if (this.watcher) {
      this.watcher.dispose();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.emitDebounceTimer) {
      clearTimeout(this.emitDebounceTimer);
      this.emitDebounceTimer = null;
    }
    this.stopFastScan();
  }
}
