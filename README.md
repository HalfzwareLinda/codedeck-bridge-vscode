# Codedeck Bridge — VSCode Extension

Bridges Claude Code sessions running in VSCode to the [Codedeck](https://github.com/HalfzwareLinda/codedeck) mobile app over Nostr relays. Watches Claude Code's JSONL session files in real-time and relays conversation data using NIP-44 encryption.

## Setup

1. Install the extension in VSCode
2. Open a workspace where you use Claude Code
3. Run **Codedeck: Pair Phone** from the command palette — a QR code appears
4. Scan the QR code with the Codedeck app on your phone
5. Your Claude Code sessions appear on the phone in real-time

## Features

- Real-time session streaming from Claude Code JSONL files
- QR code pairing via `codedeck://` deep links
- NIP-44 encrypted communication over configurable Nostr relays
- Bidirectional: send input, approve permissions, and change modes from your phone
- **Permission request cards**: Detects tool permission prompts and forwards interactive Allow/Deny/Always cards to the phone
- **Plan approval forwarding**: ExitPlanMode tool calls parsed and forwarded as interactive cards
- **Question forwarding**: AskUserQuestion tool calls forwarded as multi-choice question cards
- **Image upload relay**: Reassembles chunked image uploads from the phone and writes to `.codedeck/uploads/`
- **Remote session creation**: Start new Claude Code terminals from the phone with direct `claude --session-id` spawning
- **Close remote sessions**: Phone can request terminal closure; bridge disposes terminal and sends acknowledgment
- **Session deduplication**: Multiple JSONL files sharing a session ID are deduplicated (keeps most recent)
- **Session title back-fill**: Extracts first user message for sessions with missing titles
- History catch-up on reconnect with sequence-based gap detection
- **Mode switching**: Runtime permission mode cycling (plan/default/acceptEdits) via Shift+Tab, with auto-approve in default (YOLO) mode
- **Reliability**: Exponential backoff reconnection, TOCTOU-safe file reads, terminal liveness checks, memory-bounded history buffers
- Relay rate-limit resilience for session-ready events
- Status bar indicator showing connection state

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
npm test             # vitest
```

## Architecture

```
Claude Code (writes JSONL) → SessionWatcher → JSONL Parser → NostrRelay → Phone (Codedeck)
Phone (Codedeck) → NostrRelay → TerminalBridge → Claude Code terminal (sendText)
```

## Related

- [Codedeck](https://github.com/HalfzwareLinda/codedeck) — Tauri v2 phone/desktop app (React 19 + Rust)

## License

MIT
