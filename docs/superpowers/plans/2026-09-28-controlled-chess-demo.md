# Controlled Chess Browser Demo Implementation Plan

> **For agentic workers:** Execute inline in this session. Keep each step independently verifiable and preserve the per-action human approval gate.

**Goal:** Complete a local chess game through real Jev browser previews and approved actions.

**Architecture:** `scripts/chess-demo-site.ts` derives the board and legal link destinations from URL move history using `chess.js`. `scripts/chess-demo.ts` starts a disposable HTTPS fixture, injects loopback routing into the browser driver only for the demo, and drives the existing interactive service with live TypeSafe decisions and terminal approval. Production policies stay unchanged.

**Tech Stack:** Node 22+, TypeScript, Playwright, `chess.js@1.4.0`, TypeSafe SDK already pinned in the repository.

## Global constraints

- Keep the demo local and ephemeral; never alter `src/security/url-policy.ts` or production MCP configuration.
- Use exact, legal move URLs; every GET recomputes state without mutation.
- Show source, label, destination, and confidence before each execution; never print tokens or credentials.
- Stop on low confidence, wrong action, expired token, or missing exact terminal verification.

### Task 1: Immutable chess fixture

**Files:** Create `scripts/chess-demo-site.ts`; test in `test/chess-demo.test.ts`; add `chess.js@1.4.0` as a pinned development dependency.

- [x] Write tests for opening `f3`, legal `e7e5` link, replay-safe immutable move URL, and terminal `f3 e5 g4 Qh4#` position.
- [x] Run `npx tsx --test test/chess-demo.test.ts` and confirm the missing fixture fails.
- [x] Implement `renderChessPage(pathname: string): { status: number; html: string }` with strict coordinate move parsing and `chess.js` legality checks.
- [x] Run the focused test and `npm run typecheck`; fix failures.

### Task 2: Real browser path

**Files:** Extend `scripts/chess-demo-site.ts`; create `scripts/chess-demo.ts`; extend `test/chess-demo.test.ts`.

- [x] Write a Playwright/interactive-service test that follows `e7e5` and `d8h4` with a deterministic Jev transport, verifies only GETs, and observes exact checkmate text after the second action.
- [x] Run the focused test and confirm it fails before the driver harness exists.
- [x] Implement disposable local TLS server and demo-only proxy/hostname injection; keep the normal driver and network policy intact.
- [x] Run the focused test, full `npm test`, `npm run typecheck`, `npm run build`, and `npm audit --omit=dev`.

### Task 3: Live supervised run

**Files:** `scripts/chess-demo.ts`, `package.json`, and `README.md`.

- [x] Implement an interactive CLI that uses the existing Keychain-backed TypeSafe key, never prints its value or the preview token, and waits for explicit approval for each exact proposed move.
- [x] Start the CLI, inspect each live preview, use the user's explicit approval for the bounded game, then execute and verify the terminal result.
- [x] Capture the resulting board and report live Jev confidence, action sequence, test results, and any limitation accurately.
