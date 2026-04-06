# Codedeck Bridge — VSCode Extension

Bridges Claude Code to the [Codedeck](https://github.com/HalfzwareLinda/codedeck) mobile app over Nostr relays. Uses the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) to spawn Claude Code as a subprocess with structured JSON communication — no terminal emulation or JSONL file watching.

## Setup

1. Install the extension in VSCode
2. Open a workspace where you use Claude Code
3. Run **Codedeck: Pair Phone** from the command palette — a QR code appears
4. Scan the QR code with the Codedeck app on your phone
5. Your Claude Code sessions appear on the phone in real-time

## Features

- **Claude Agent SDK integration**: Spawns Claude Code as a subprocess via `query()` — structured JSON input/output, no terminal emulation
- **Structured permissions**: SDK's `canUseTool()` callback handles tool approvals — auto-approve based on mode, or forward interactive cards to the phone
- **Direct mode/effort control**: `setPermissionMode()` and `applyFlagSettings()` — no keystroke simulation
- **Session resume**: Automatic crash recovery via SDK's `resume` option (up to 2 restarts)
- **Smart session titles**: Extracts topic and project from Claude's first response via metadata comment
- QR code pairing via `codedeck://` deep links
- NIP-44 encrypted communication over configurable Nostr relays
- Plan approval, question, and permission request forwarding as interactive cards
- Image upload relay (Blossom AES-256-GCM decryption or legacy chunked reassembly)
- History catch-up on reconnect with sequence-based gap detection
- Effort level control (low/medium/high/max/auto)
- Session heartbeat every 60s for phone-side staleness detection
- Exponential backoff reconnection (2s → 30s), memory-bounded history buffers (500/session)
- Status bar indicator showing connection state and paired phone count

## Commands

- `Codedeck: Pair Phone` — Show QR code for phone pairing
- `Codedeck: Status` — Show connection status
- `Codedeck: Disconnect` — Disconnect all phones

## Settings

- `codedeck.relays` — Nostr relay URLs (default: `wss://relay.primal.net`, `wss://relay.nostr.band`, `wss://nos.lol`)
- `codedeck.machineName` — Display name for this machine (defaults to hostname)

## Development

```bash
npm install
npm run build        # esbuild bundle to out/extension.js
npm run watch        # esbuild watch mode
npm run typecheck    # tsc --noEmit
npm run package      # vsce package (creates .vsix)
npm test             # vitest (29 tests)
```

## Architecture

```
Phone (Codedeck) ──Nostr──> NostrRelay → BridgeCore → SdkSessionManager → SDK query() → Claude Code subprocess
Claude Code subprocess → SDK messages → SdkAdapter → BridgeCore → NostrRelay ──Nostr──> Phone (Codedeck)
```

### Source Files

| File | Role |
|------|------|
| `src/extension.ts` | VSCode lifecycle, keypair management, heartbeat, crash recovery |
| `src/core.ts` | Pure Node.js orchestrator wiring Nostr relay ↔ SDK sessions |
| `src/sdkSession.ts` | SDK session manager: `query()` instances, async input generators, `canUseTool()` permission handling |
| `src/sdkAdapter.ts` | Translates `SDKMessage` → `OutputEntry` for the Nostr protocol |
| `src/nostrRelay.ts` | Nostr client, NIP-44 encryption, output throttling, event deduplication |
| `src/pairing.ts` | QR code generation for phone pairing |
| `src/statusBar.ts` | Status bar indicator |
| `src/types.ts` | Protocol types and event kind constants |

### Nostr Event Protocol

| Kind | Type | Purpose | Tags |
|------|------|---------|------|
| 30515 | NIP-33 replaceable | Session list | `['d', machineName]`, `['p', phonePubkey]` |
| 4515 | Regular | Output stream, history, control messages | `['p', phonePubkey]`, `['s', sessionId]`, `['seq', N]` |

All content NIP-44 encrypted.

## Related

- [Codedeck](https://github.com/HalfzwareLinda/codedeck) — Tauri v2 phone/desktop app (React 19 + Rust)

## License

MIT
