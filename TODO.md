# Codedeck Bridge TODO

## Backlog — Architecture

- [x] **Event-driven new session detection** — Replaced the polling loop in `core.ts:waitForNewSession()` with `awaitNewSession()`, a one-shot promise that resolves when `SessionWatcher.onNewSession` fires. Added `scanForNewFiles()` as a lightweight backup scan (every 3s) for when `FileSystemWatcher` doesn't fire. 60s timeout safety net.

- [x] **Snapshot-diff session detection (v3)** — The event-driven approach still failed because `onNewSession` callback never fired when `FileSystemWatcher` missed the new file or `indexSession` failed on an empty file. Fix: `onCreateSession` now snapshots all known session IDs, starts a 2s diff-polling interval that calls `scanForNewFiles()` + `findNewSessionNotIn(snapshot)`, and resolves via `resolvePendingSession()`. Three independent detection paths now race: (1) `onNewSession` callback via FileSystemWatcher, (2) `onNewSession` via `scanForNewFiles` fast scan, (3) snapshot-diff polling. Also added half-indexed file recovery in `scanForNewFiles` and diagnostic logging throughout.

## Low Priority — Relay Hygiene (NIP-40 Expiration)

- [ ] **Add 1-hour expiration to history response events** — `nostrRelay.ts:publishHistory()` — Add `['expiration', ...]` tag to kind 29515 history events (`['t', 'history']`). These are one-shot catch-up payloads, pure waste after delivery. Easiest win.

- [ ] **Add 7-day expiration to output stream events** — `nostrRelay.ts:publishOutput()` — Add `['expiration', ...]` tag to kind 29515 output events. Matches the bridge's own 7-day `MAX_AGE_MS` session filter. Polite to relay operators but relay support for NIP-40 varies.

## Fixed Bugs (2026-03-01)

- [x] **Seq counters reset on extension restart** — `scanAllSessions()` now calls `loadFullHistory()` at startup to derive seq from file content. Consolidated to single seq source in `sessionWatcher` (removed duplicate counter from `nostrRelay`).

- [x] **sendToClaudeTerminal ignores sessionId** — Replaced stateless functions with `TerminalRegistry` class. Uses temporal correlation (`onNewSession`) + remembered-terminal strategy for session-to-terminal mapping. Priority chain: known terminal > single terminal > active Claude terminal > first Claude terminal.

- [x] **savePairedPhones not awaited** — Made callback async, added `await` with try-catch error handling. Save failure now prevents relay reconnection and shows error to user.

- [x] **Status bar not updated after relay config change** — Added `setConnectionCallback()` to `NostrRelay`. Fires `connected`/`disconnected`/`error` events wired to status bar updates. Config change handler sets offline state during reconnection.

- [x] **Dynamic require() for NIP-44** — Added `getConversationKey` to top-level import. Removed `nip44GetConversationKey` wrapper function.

- [x] **Stale history for deleted sessions** — `pollActiveFiles()` catch block now extracts sessionId before cleanup, mirrors `onFileDeleted()` pattern. Also emits session list update.
