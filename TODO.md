# Codedeck Bridge TODO

## Fixed Bugs (2026-03-01)

- [x] **Seq counters reset on extension restart** — `scanAllSessions()` now calls `loadFullHistory()` at startup to derive seq from file content. Consolidated to single seq source in `sessionWatcher` (removed duplicate counter from `nostrRelay`).

- [x] **sendToClaudeTerminal ignores sessionId** — Replaced stateless functions with `TerminalRegistry` class. Uses temporal correlation (`onNewSession`) + remembered-terminal strategy for session-to-terminal mapping. Priority chain: known terminal > single terminal > active Claude terminal > first Claude terminal.

- [x] **savePairedPhones not awaited** — Made callback async, added `await` with try-catch error handling. Save failure now prevents relay reconnection and shows error to user.

- [x] **Status bar not updated after relay config change** — Added `setConnectionCallback()` to `NostrRelay`. Fires `connected`/`disconnected`/`error` events wired to status bar updates. Config change handler sets offline state during reconnection.

- [x] **Dynamic require() for NIP-44** — Added `getConversationKey` to top-level import. Removed `nip44GetConversationKey` wrapper function.

- [x] **Stale history for deleted sessions** — `pollActiveFiles()` catch block now extracts sessionId before cleanup, mirrors `onFileDeleted()` pattern. Also emits session list update.
