# Controlled Chess Browser Demo

## Goal

Play one complete, reproducible chess game against a local bot to demonstrate the existing split of responsibility: Codex plans the chess moves, Jev selects matching browser links, and the guarded browser executes each approved action.

## Boundary

The demonstration runs only in a disposable local HTTPS fixture. Its test-only driver maps a syntactically public hostname to loopback; the production MCP's public-host policy and tools are unchanged. No Chess.com account, personal browser profile, external form, or remote chess service is involved.

## Game and UI

`chess.js` validates every move. The bot plays White, opens with `f3`, then plays `g4` after Black's first move when legal. Codex's demonstration plan for Black is `e7e5`, then `d8h4`, ending in checkmate. The site renders a visible board, move history, status, and links for all legal Black moves. Each link points to an immutable path containing only Black's move history. A GET recomputes the resulting position and bot reply; no request mutates server state.

## Browser flow

The demonstration invokes the real `InteractiveSessionService`, `InteractiveBrowserDriver`, and TypeSafe transport. Jev sees the board text and code-owned move links, then chooses one action ID. The CLI shows source URL, move label, destination, and confidence without printing the approval token. It waits for explicit human approval for each move; a trusted operator may provide it when the user has authorized the whole bounded game. Low confidence, a wrong proposed move, timeout, or other ambiguous result stops the run. After the final move, code verifies the exact URL and visible checkmate text returned by the browser instead of requesting a third Jev decision about an already observed result.

## Verification

Unit tests check legal move links, immutable/replay-safe paths, and the final checkmate position. A browser test uses synthetic Jev answers to verify the two approved navigations and terminal result through the actual Playwright driver. A live run with the Keychain-backed TypeSafe key is reported separately from synthetic tests.
