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
import { parseJsonlLine, extractSessionMeta, extractFirstUserMessage } from './jsonlParser';
import type { OutputEntry, RemoteSessionInfo } from './types';

const MAX_HISTORY_PER_SESSION = 500;

export interface SessionWatcherEvents {
  onOutput: (sessionId: string, entries: Array<{ seq: number; entry: OutputEntry }>) => void;
  onSessionListChanged: (sessions: RemoteSessionInfo[]) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
}

export class SessionWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | null = null;
  private fileOffsets: Map<string, number> = new Map();
  private sessionMeta: Map<string, { sessionId: string; slug: string; cwd: string; title: string | null }> = new Map();
  private sessionHistory: Map<string, Array<{ seq: number; entry: OutputEntry }>> = new Map();
  private seqCounters: Map<string, number> = new Map();
  private events: SessionWatcherEvents;
  private claudeDir: string;
  private pollInterval: NodeJS.Timeout | null = null;
  private emitDebounceTimer: NodeJS.Timeout | null = null;

  constructor(events: SessionWatcherEvents) {
    this.events = events;
    this.claudeDir = path.join(os.homedir(), '.claude', 'projects');
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

      this.emitSessionList();
    } catch (err) {
      console.error('[Codedeck] Error scanning sessions:', err);
    }
  }

  private indexSession(filePath: string): void {
    // Skip subagent sessions
    if (filePath.includes('/subagents/')) { return; }

    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(4096);
      let bytesRead: number;
      try {
        bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      } finally {
        fs.closeSync(fd);
      }

      const chunk = buf.toString('utf8', 0, bytesRead);
      const lines = chunk.split('\n').filter(l => l.trim());
      const meta = extractSessionMeta(lines);

      if (meta) {
        // Try to extract title from the initial chunk, fallback to reading more lines
        let title = extractFirstUserMessage(lines);
        if (!title) {
          title = this.extractTitleFromFile(filePath);
        }
        this.sessionMeta.set(filePath, { ...meta, title });
        // Set offset to current file size (don't replay old content)
        const stat = fs.statSync(filePath);
        this.fileOffsets.set(filePath, stat.size);
      }
    } catch {
      // File may be in use or corrupted, skip
    }
  }

  private extractTitleFromFile(filePath: string): string | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines: string[] = [];
      let count = 0;
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        lines.push(line);
        if (++count >= 10) break;
      }
      return extractFirstUserMessage(lines);
    } catch { return null; }
  }

  private onFileCreated(filePath: string): void {
    if (!filePath.endsWith('.jsonl')) { return; }
    if (filePath.includes('/subagents/')) { return; }

    // New session file — index it and start from beginning
    this.fileOffsets.set(filePath, 0);
    this.indexSession(filePath);
    this.emitSessionList();

    // Notify of new session for terminal correlation
    const meta = this.sessionMeta.get(filePath);
    if (meta) {
      this.events.onNewSession?.(meta.sessionId, meta.cwd);
    }

    // Process any initial content
    this.readNewLines(filePath);
  }

  private onFileChanged(filePath: string): void {
    if (!filePath.endsWith('.jsonl')) { return; }
    if (filePath.includes('/subagents/')) { return; }

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
        const meta = extractSessionMeta(lines);
        if (meta) {
          const title = extractFirstUserMessage(lines) ?? this.extractTitleFromFile(filePath);
          this.sessionMeta.set(filePath, { ...meta, title });
          this.emitSessionList();
        }
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
    } catch {
      // File may have been deleted between stat and read
    }
  }

  private pollActiveFiles(): void {
    for (const filePath of [...this.fileOffsets.keys()]) {
      try {
        const stat = fs.statSync(filePath);
        const offset = this.fileOffsets.get(filePath) ?? 0;
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

  getSessions(): RemoteSessionInfo[] {
    const sessions: RemoteSessionInfo[] = [];
    const now = Date.now();
    const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const MAX_SESSIONS = 50;

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
          project: path.basename(meta.cwd) || meta.cwd,
        });
      } catch {
        // File gone
      }
    }
    // Sort by last activity, most recent first — cap to avoid oversized Nostr events
    sessions.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
    return sessions.slice(0, MAX_SESSIONS);
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
  }
}
