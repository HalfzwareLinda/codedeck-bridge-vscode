# Codedeck Bridge — VSCode Extension

Bridges Claude Code sessions running in VSCode to the Codedeck mobile app over Nostr relays. Watches Claude Code's JSONL session files in real-time and relays conversation data using NIP-44 encryption.

## Quick Start

```bash
npm install
npm run build        # esbuild bundle to out/extension.js
npm run watch        # esbuild watch mode
npm run typecheck    # tsc --noEmit
npm run package      # vsce package (creates .vsix)
npm test             # vitest (36 tests)
```

## Architecture

```
Claude Code (writes JSONL) → SessionWatcher → JSONL Parser → NostrRelay → Phone (Codedeck)
Phone (Codedeck) → NostrRelay → TerminalBridge → Claude Code terminal (sendText)
```

### Source Files

- `src/extension.ts` — VSCode lifecycle, thin wrapper using BridgeCore
- `src/core.ts` — Pure Node.js orchestrator with `SessionProvider` and `TerminalSender` interfaces
- `src/sessionWatcher.ts` — FileSystemWatcher for `~/.claude/projects/*/*.jsonl`, tail-f style, history buffer (500 entries/session), per-session seq counters
- `src/jsonlParser.ts` — Parses Claude Code JSONL lines into `OutputEntry` (handles user/assistant/system/tool_use/tool_result, skips progress/queue-operation/file-history-snapshot)
- `src/nostrRelay.ts` — Nostr client using `nostr-tools`, NIP-44 encryption, keypair generation/storage
- `src/terminalBridge.ts` — Finds Claude Code terminals in VSCode, sends input via `terminal.sendText()`
- `src/pairing.ts` — QR code generation for phone pairing (`codedeck://pair?npub=...&relays=...`)
- `src/statusBar.ts` — Status bar indicator
- `src/types.ts` — Protocol types and event kind constants
- `src/__tests__/` — Tests for JSONL parser (21 tests) and protocol types (15 tests)

### Nostr Event Protocol

| Purpose | Kind | Tags |
|---|---|---|
| Session list | 30515 (NIP-33 replaceable) | `['d', machineName]`, `['p', phonePubkey]` |
| Output stream | 29515 (regular) | `['p', phonePubkey]`, `['s', sessionId]`, `['seq', N]` |
| History response | 29515 (regular) | `['p', phonePubkey]`, `['s', sessionId]`, `['t', 'history']` |

All content NIP-44 encrypted. Messages: `sessions`, `output`, `history`, `input`, `permission-res`, `mode`, `history-request`, `close-session`, `close-session-ack`.

### VSCode Commands

- `codedeck.pair` — Show QR code for phone pairing
- `codedeck.status` — Show connection status
- `codedeck.disconnect` — Disconnect all phones

### Extension Settings

- `codedeck.relays` — Nostr relay URLs (default: `wss://relay.primal.net`, `wss://relay.nostr.band`, `wss://nos.lol`)
- `codedeck.machineName` — Display name for this machine (defaults to hostname)

## Build Notes

- `nostr-tools` is ESM-only; esbuild bundles it to CJS for VSCode extension compatibility
- `subscribeMany` takes a single `Filter` object, not `Filter[]` — combine kinds into one filter
- Bridge keypair auto-generated on first activation, stored in `context.globalState`

## Related Repo

- `codedeck/` — Tauri v2 phone/desktop app (React 19 + Rust)
- GitHub: `HalfzwareLinda/codedeck`

## Claude Code JSONL Format

Session files at `~/.claude/projects/<path>/<uuid>.jsonl`. Each line is JSON with `type` field:
- `user` / `assistant` — conversation messages with `content[]` blocks
- `system` — system notifications
- `progress`, `queue-operation`, `file-history-snapshot` — skipped (internal bookkeeping)
