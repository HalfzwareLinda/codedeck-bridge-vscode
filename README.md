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
- History catch-up on reconnect with sequence-based gap detection
- Status bar indicator showing connection state

## Commands

- `Codedeck: Pair Phone` — Show QR code for phone pairing
- `Codedeck: Status` — Show connection status
- `Codedeck: Disconnect` — Disconnect all phones

## Settings

- `codedeck.relays` — Nostr relay URLs (default: `wss://relay.damus.io`, `wss://nos.lol`)
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
