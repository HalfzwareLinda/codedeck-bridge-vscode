# Codedeck Bridge TODO

## Known Bugs (from static analysis 2026-03-01)

- [ ] **Seq counters reset on extension restart** — `sessionWatcher.ts:244`, `nostrRelay.ts:174` — Both seq counters start at 0 on restart. Phone may receive duplicate entries on reconnect. Fix: persist seq counters in `context.globalState` or derive from loaded history.

- [ ] **sendToClaudeTerminal ignores sessionId** — `terminalBridge.ts:29-47` — Input always goes to the first Claude terminal found, not the correct one for the session. Fix: implement session-to-terminal mapping (could use terminal name or metadata).

- [ ] **savePairedPhones not awaited** — `extension.ts:132` — `savePairedPhones()` returns `Thenable<void>` but is not awaited. If save fails, phones are updated in memory but not persisted. Fix: `await savePairedPhones(context, phones)`.

- [ ] **Status bar not updated after relay config change** — `extension.ts:180-188` — The configuration change watcher updates relays but never reflects connection status back to the status bar. If relay reconnection fails, user still sees "ready".

- [ ] **Dynamic require() for NIP-44** — `nostrRelay.ts:295-300` — Uses `require('nostr-tools/nip44')` instead of top-level import. Anti-pattern for ESM bundling. Fix: use top-level import.

- [ ] **Stale history for deleted sessions** — `sessionWatcher.ts:79-121` — If a session file is deleted between buffer updates, the history remains in memory indefinitely. Fix: periodically prune history for sessions without files.
