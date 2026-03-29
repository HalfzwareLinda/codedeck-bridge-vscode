# TODO — Codedeck Bridge (VSCode Extension)

## Mode Tracking

- [ ] **CDB-001: Optimistic mode tracking drifts from actual terminal state** — The Shift+Tab keystroke approach for mode switching is unreliable: Claude Code can change its own mode between our Shift+Tab sends and the next observation. Investigate reading the actual mode from terminal output or Claude Code's state instead of tracking it optimistically.

## Permissions

- [ ] **CDB-002: Consider `--dangerously-skip-permissions` CLI flag** — For sessions that start in bypass mode, spawn Claude with `--dangerously-skip-permissions` instead of using the mockup auto-approve approach. Eliminates race conditions and latency from keypress-based auto-approval. Can't be toggled mid-session (requires process restart), so keep mockup fallback for mid-session switches.

## Relay Hygiene (NIP-40 Expiration)

- [ ] **CDB-003: Add 1-hour expiration to history response events** — `nostrRelay.ts:publishHistory()` — Add `['expiration', ...]` tag to kind 29515 history events. These are one-shot catch-up payloads, pure waste after delivery.
- [ ] **CDB-004: Add 7-day expiration to output stream events** — `nostrRelay.ts:publishOutput()` — Add `['expiration', ...]` tag to kind 29515 output events. Matches the bridge's own 7-day `MAX_AGE_MS` session filter.
