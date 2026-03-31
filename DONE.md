# Done — Codedeck Bridge (VSCode Extension)

## Architecture

- [x] **Event-driven new session detection** — Replaced polling loop in `core.ts:waitForNewSession()` with `awaitNewSession()`, one-shot promise resolving on `SessionWatcher.onNewSession`. Added `scanForNewFiles()` backup scan (every 3s). 60s timeout safety net.
- [x] **Snapshot-diff session detection (v3)** — Three independent detection paths race: (1) `onNewSession` via FileSystemWatcher, (2) `onNewSession` via `scanForNewFiles` fast scan, (3) snapshot-diff polling. Half-indexed file recovery and diagnostic logging added.

## Reliability Audit (2026-03-03)

- [x] **Relay reconnection with exponential backoff** — `scheduleReconnect()` (2s->30s cap) in `nostrRelay.ts`.
- [x] **Output queue cap** — `MAX_OUTPUT_QUEUE_SIZE` raised from 200 to 500.
- [x] **TOCTOU in readNewLines** — `openSync()` first, `fstatSync(fd)` second. ENOENT cleans up stale offsets.
- [x] **Terminal liveness checks** — `exitStatus !== undefined` guard before each `sendText()`.
- [x] **Pending timer cleanup** — `pendingTimers` Set tracked in `TerminalRegistry`, cleared in `dispose()`.
- [x] **Concurrent flush guard** — `flushingSession` Set prevents double-sends in `flushPendingInputs()`.
- [x] **LRU history eviction** — standalone 5-min interval evicts idle sessions when total exceeds 10K entries.
- [x] **Dead session pruning** — `pruneDeletedSessions()` checks `fs.existsSync` every ~36s.
- [x] **Dispose lifecycle** — `dispose()` sets `disposed = true` then `disconnect()` — prevents post-deactivation reconnects.

## Bug Fixes (2026-03-01)

- [x] **Seq counters reset on extension restart** — `scanAllSessions()` calls `loadFullHistory()` at startup to derive seq from file content. Consolidated to single seq source.
- [x] **sendToClaudeTerminal ignores sessionId** — Replaced stateless functions with `TerminalRegistry` class. Uses temporal correlation + remembered-terminal strategy.
- [x] **savePairedPhones not awaited** — Made callback async, added `await` with try-catch. Save failure now prevents relay reconnection.
- [x] **Status bar not updated after relay config change** — Added `setConnectionCallback()` to `NostrRelay`. Fires connected/disconnected/error events.
- [x] **Dynamic require() for NIP-44** — Added `getConversationKey` to top-level import.
- [x] **Stale history for deleted sessions** — `pollActiveFiles()` catch block now extracts sessionId before cleanup.

## Session Management Overhaul (2026-03-01 — 2026-03-08)

- [x] **Workspace folder fallback for session display** — Use workspace folder as fallback cwd so new sessions are visible (`96f81e8`, 2026-03-01)
- [x] **Project subfolder in session tiles** — Show project subfolder name instead of workspace name (`a1b1014`, 2026-03-01)
- [x] **Permission cards, image upload relay, session title back-fill** — Added to bridge output (`1a5eb4a`, 2026-03-02)
- [x] **Fix create-session not publishing session list** — Session list now published to phone on create (`55fd84d`, 2026-03-02)
- [x] **Output throttling, session list retry, poll re-index** — Improved reliability of session list delivery (`7ea7aa9`, 2026-03-02)
- [x] **Refresh-sessions protocol message** — Added for pull-to-refresh on phone (`30ee5c0`, 2026-03-02)
- [x] **Fix invisible sessions from file-history-snapshot** — JSONL starting with snapshot no longer hides session (`ad806c2`, 2026-03-02)
- [x] **Fix new session detection cap and timeout** — Bypass 15-cap, extend timeout to 45s (`c50d78c`, 2026-03-02)
- [x] **Two-phase session creation** — Immediate ack system for responsive UX (`3c7016c`, 2026-03-02)
- [x] **Snapshot-diff polling fallback** — Additional detection path for new sessions (`dcff79c`, 2026-03-02)
- [x] **Session list delivery fixes** — Debounce, NIP-33 timestamp, "replaced" handling (`7e71f10`, 2026-03-02)
- [x] **Direct `claude --session-id` spawning** — Replaced session detection chain with direct spawn (`da0c86f`, 2026-03-02)
- [x] **Fix spawned sessions not loading workspace config** — Workspace config now applied (`cf37d3c`, 2026-03-02)
- [x] **Remove auto-open terminal fallback** — Cleaned up for existing sessions (`429bdb2`, 2026-03-02)
- [x] **Relay rate-limit resilience** — For session-ready events (`2e4f5c7`, 2026-03-02)
- [x] **Handle close-session requests** — Deduplicate session list on close (`13f155f`, 2026-03-06)
- [x] **Publish session-replaced event** — When plan option 1 clears context (`152fc67`, 2026-03-08)

## Permission Card & Input Fixes (2026-03-02 — 2026-03-08)

- [x] **Escape+Enter workaround for Ink TUI** — Fix phone input not submitted (`f192e12`, 2026-03-02)
- [x] **Fix sendText line ending** — Use `\n` instead of `\r` for VSCode (`95ee264`, 2026-03-02)
- [x] **Bypass Escape+Enter for raw keypresses** — Fix permission responses rejected (`c318d23`, 2026-03-03)
- [x] **Fix permission card race condition** — Cards now show reliably on phone (`0ec88fc`, 2026-03-03)
- [x] **Fix "Response sent..." stuck state** — Added robustness to permission flow (`3b5cae3`, 2026-03-03)
- [x] **Fix wrong keystrokes to Ink SelectInput** — Correct key mapping for permission responses (`6462649`, 2026-03-03)
- [x] **Fix permission cards for Read/Glob/Grep** — Cards now show for read-only tools (`768d956`, 2026-03-03)
- [x] **Delay input delivery after keypress** — Fix plan revision input timing (`fb2fe59`, 2026-03-08)

## Keypress Protocol (2026-03-03)

- [x] **Keypress protocol message** — Added keypress protocol and incremental permission tracking (`19f1d19`, 2026-03-03)

## Permission Mode Switching & Plan Mode (2026-03-03 — 2026-03-23)

- [x] **Runtime permission mode cycling** — Shift+Tab mode cycling via terminal (`79df180`, 2026-03-03)
- [x] **Optimistic mode tracking** — Replaced broken JSONL verify-retry with optimistic tracking (`88578f6`, 2026-03-03)
- [x] **Denylist permission detection** — Refactored to denylist approach (`8a2f187`, 2026-03-03)
- [x] **Auto-approve read-only tools in plan mode** — Read/Glob/Grep auto-approved (`3282c60`, 2026-03-04)
- [x] **Fix mode cycling off-by-one** — Launch sessions with `--permission-mode plan` (`3220969`, 2026-03-04)
- [x] **Correct MODE_CYCLE order** — Add bypass auto-approve, clean up on close (`2f36c2a`, 2026-03-07)
- [x] **Mode debounce and drift correction** — Abort in-flight switches, fix drift loop (`8eb602f`, 2026-03-07)
- [x] **Preemptive mode tracking after plan approval** — Keypresses tracked preemptively (`c97ff89`, 2026-03-08)
- [x] **Auto-approve Bash/Write/Edit/ExitPlanMode/ToolSearch** — Extended auto-approve set for plan mode (`1179919`, 2026-03-09)
- [x] **Queue auto-approve keypresses** — Prevent race condition in plan mode (`b550f19`, 2026-03-15)
- [x] **Plan revision input + permission cards** — Plan mode revision UX improvements (`7113692`, 2026-03-15)
- [x] **Auto-approve retry for stale inflight items** — Keypress delay handling (`871aa57`, 2026-03-15)
- [x] **Auto-approve retries independent of JSONL** — Fire retries independently of file changes (`b8d1e13`, 2026-03-15)
- [x] **Remove ExitPlanMode from auto-approve set** — Prevents unintended plan exits (`4d7db35`, 2026-03-23)
- [x] **Prevent mode desync after plan approval** — Fix switching immediately after approval (`b024614`, 2026-03-23)
- [x] **CDB-005: Single auto-approve path with stale response guard** — Bridge is sole auto-approve authority. Shared `emitFallbackPermissionCard()` helper, split `getStaleInflight()` into pure query + mutations, `isToolResolved()` guard prevents phantom keypresses (`1b1c111`, 2026-03-29)
- [x] **CDB-006: Centralize bypassPermissions mapping + event-driven mode verification** — Single `toTerminalMode()` helper replaces 3 scattered ternaries, fixes latent bug in `onSessionListChanged`. Replaced fragile 3s setTimeout verification with event-driven verification in `onPermissionModeObserved` (max 2 retries, 10s window) (`c05d741`, 2026-03-29)
- [x] **CDB-007: Harden mode-confirmed** — No-op confirm, failure revert, plan approval, dedup bypass (`910df1f`, 2026-03-29)
- [x] **CDB-008: Cancellable auto-approve keypresses** — Auto-approve keypresses are now cancellable and pause-aware (`dca57eb`, 2026-03-29)
- [x] **CDB-009: Eliminate bypassPermissions mode** — Removed bypassPermissions entirely, use default + auto-approve (`b0e26dd`, 2026-03-29)
- [x] **CDB-011: Detect autonomous plan mode entry via EnterPlanMode tool_use** — Phone UI stayed in "EDITS" when Claude Code autonomously entered plan mode. Added `extractModeFromToolUse()` to detect EnterPlanMode and fire `mode-confirmed` (`e9f2de9`, 2026-03-31)

## Blossom Image Transfer (2026-03-04 — 2026-03-08)

- [x] **Blossom encrypted image downloads** — Support alongside legacy chunk transfer (`d9fe3b3`, 2026-03-04)
- [x] **AES-256-GCM for Blossom decryption** — Replaced NIP-44 decryption (`a070a6f`, 2026-03-08)

## UX Improvements (2026-03-03 — 2026-03-23)

- [x] **Filter system messages from session titles** — Cleaner title extraction (`fe7ec3a`, 2026-03-03)
- [x] **Quick-menu, connecting state, better errors** — UX polish pass (`ef620db`, 2026-03-03)
- [x] **AskUserQuestion metadata** — Added `question_index` and `question_count` fields (`9302f2d`, 2026-03-23)

## Relay Configuration (2026-03-02 — 2026-03-03)

- [x] **Replace relay.damus.io** — Switched to less congested relays (`3de6f78`, 2026-03-02)
- [x] **Replace relay.nos.social** — Switched to relay.nostr.band (`5adba8a`, 2026-03-03)

## Error Handling & Recovery (2026-03-03)

- [x] **Event handler error handling** — Terminal slug-based recovery added (`d12d3f5`, 2026-03-03)
