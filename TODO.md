# TODO — Codedeck Bridge (VSCode Extension)

## Mode Tracking

- [ ] **CDB-001: Optimistic mode tracking drifts from actual terminal state** — The Shift+Tab keystroke approach for mode switching is unreliable: Claude Code can change its own mode between our Shift+Tab sends and the next observation. Investigate reading the actual mode from terminal output or Claude Code's state instead of tracking it optimistically.

## Permissions

- [ ] **CDB-002: Consider `--dangerously-skip-permissions` CLI flag** — For sessions that start in default (YOLO) mode, spawn Claude with `--dangerously-skip-permissions` instead of using the bridge auto-approve approach. Eliminates race conditions and latency from keypress-based auto-approval. Can't be toggled mid-session (requires process restart), so keep bridge auto-approve fallback for mid-session switches.
- [ ] **CDB-014: Re-test permission scorecard after CDB-013 fix** — Run the Plan Mode and Accept Edits scorecards from the phone to verify: Plan mode prompts for Write/Edit, Accept Edits auto-approves Write/Edit but prompts for Bash/WebSearch/Agent.
- [ ] **CDB-015: Test tool approvals across all three build modes** — Systematically test which tools get auto-approved vs prompted across Plan Mode, Accept Edits, and Full Auto (YOLO) modes. Verify each mode's approval matrix matches expected behavior for Read/Glob/Grep, Write/Edit, Bash, WebSearch, and Agent tools.

## Relay Hygiene (NIP-40 Expiration)

- [ ] **CDB-003: Add 1-hour expiration to history response events** — `nostrRelay.ts:publishHistory()` — Add `['expiration', ...]` tag to kind 29515 history events. These are one-shot catch-up payloads, pure waste after delivery.
- [ ] **CDB-004: Add 7-day expiration to output stream events** — `nostrRelay.ts:publishOutput()` — Add `['expiration', ...]` tag to kind 29515 output events. Matches the bridge's own 7-day `MAX_AGE_MS` session filter.
