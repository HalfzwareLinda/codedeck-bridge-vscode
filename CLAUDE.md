# Codedeck Bridge — VSCode Extension

Bridges Claude Code sessions to the Codedeck mobile app over Nostr relays. Uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) to spawn Claude Code as a subprocess with structured JSON communication — no terminal emulation or JSONL file watching.

## Quick Start

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
Phone (Codedeck) ──Nostr──> NostrRelay → BridgeCore → SdkSessionManager → SDK stdin (JSON) → Claude Code subprocess
Claude Code subprocess → SDK stdout (JSON) → SdkAdapter → BridgeCore → NostrRelay ──Nostr──> Phone (Codedeck)
```

### Source Files

- `src/extension.ts` — VSCode lifecycle, thin wrapper around BridgeCore
- `src/core.ts` — Pure Node.js orchestrator wiring Nostr relay ↔ SDK sessions
- `src/sdkSession.ts` — SDK session manager: creates `query()` instances, manages async input generators, handles permissions via `canUseTool` callback
- `src/sdkAdapter.ts` — Translates `SDKMessage` → `OutputEntry` for the Nostr protocol
- `src/nostrRelay.ts` — Nostr client using `nostr-tools`, NIP-44 encryption, keypair generation/storage
- `src/pairing.ts` — QR code generation for phone pairing (`codedeck://pair?npub=...&relays=...`)
- `src/statusBar.ts` — Status bar indicator
- `src/types.ts` — Protocol types and event kind constants
- `src/__tests__/` — Tests for SDK adapter (14 tests) and protocol types (15 tests)

### Key Mechanisms

**Session creation**: Phone sends `create-session` → `SdkSessionManager.createSession()` calls SDK `query()` with `sessionId`, `cwd`, `permissionMode` → Claude Code subprocess starts immediately.

**User input**: Phone sends text → `SdkSessionManager.sendInput()` pushes `SDKUserMessage` into the async generator → SDK forwards to Claude Code stdin.

**Permissions**: SDK calls `canUseTool(toolName, input, options)` → auto-approve based on permission mode, or forward to phone as permission card → phone responds → `resolvePermission()` returns result to SDK.

**Mode switching**: Phone sends mode change → `SdkSessionManager.setPermissionMode()` calls `query.setPermissionMode()` directly — no keystroke simulation needed.

**Output**: SDK streams `SDKMessage` objects → `sdkAdapter.ts` converts to `OutputEntry[]` → published over Nostr to phone.

### Nostr Event Protocol

| Purpose | Kind | Tags |
|---|---|---|
| Session list | 30515 (NIP-33 replaceable) | `['d', machineName]`, `['p', phonePubkey]` |
| Output stream | 4515 (regular) | `['p', phonePubkey]`, `['s', sessionId]`, `['seq', N]` |
| History response | 4515 (regular) | `['p', phonePubkey]`, `['s', sessionId]`, `['t', 'history']` |

All content NIP-44 encrypted. Messages: `sessions`, `output`, `history`, `input`, `permission-res`, `mode`, `history-request`, `close-session`, `close-session-ack`.

### VSCode Commands

- `codedeck.quickMenu` — Quick menu (status bar click)
- `codedeck.pair` — Show QR code for phone pairing
- `codedeck.status` — Show connection status
- `codedeck.disconnect` — Disconnect all phones

### Extension Settings

- `codedeck.relays` — Nostr relay URLs (default: `wss://relay.primal.net`, `wss://relay.nostr.band`, `wss://nos.lol`)
- `codedeck.machineName` — Display name for this machine (defaults to hostname)

## Build Notes

- `nostr-tools` is ESM-only; esbuild bundles it to CJS for VSCode extension compatibility
- `@anthropic-ai/claude-agent-sdk` is marked as external in esbuild (bundles its own CLI binary)
- Bridge keypair auto-generated on first activation, stored in `context.globalState`

## Related Repo

- `codedeck/` — Tauri v2 phone/desktop app (React 19 + Rust)
- GitHub: `HalfzwareLinda/codedeck`
