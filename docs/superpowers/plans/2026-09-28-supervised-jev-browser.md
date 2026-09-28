# Supervised Jev Browser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate supervised Jev browser mode for public and manually authenticated reading and bounded HTTPS form submission.

**Architecture:** Keep `jev_guard_*` unchanged. A new browser service owns isolated Playwright sessions, bounded DOM actions, TypeSafe decisions, single-use approval tokens and exact request policy. Codex supplies goals and non-credential values; Jev selects code-owned action IDs; the trusted MCP client obtains approval before every action.

**Tech Stack:** Node.js 22+, TypeScript ESM, TypeSafe SDK 0.6.0, Playwright 1.63.0, MCP SDK 1.30.0, Zod 4.6.5, `tsx --test`.

**Specification:** `docs/superpowers/specs/2026-09-28-supervised-jev-browser-design.md`.

## Global Constraints

- Do not change the contracts or security policy of the three existing `jev_guard_*` tools.
- Keep the new mode in separate `src/interactive/` files and register its five `jev_browser_*` tools alongside the existing tools.
- A browser session permits at most 20 executed actions, 25 TypeSafe calls and 15 minutes from opening; at most two sessions exist concurrently.
- Approval tokens expire after 120 seconds, are random and single-use, and are consumed before any action.
- Jev chooses from code-owned IDs only; effective confidence must be at least `0.80`.
- No password, one-time code, cookie, local storage, current input value, hidden field, screenshot, selector or raw HTML is sent to TypeSafe.
- Only non-credential values may enter MCP; the user handles login in a headed, isolated, non-persistent browser context.
- `siteOrigin`, `authOrigins` and `resourceOrigins` are exact public HTTPS origins; Jev actions stay on `siteOrigin`.
- JavaScript is enabled only for the new mode; service workers, WebSockets, popups and downloads remain blocked.
- After an approved fill/select, block every new request until a single exact approved submission or cancellation.
- Never automatically retry a TypeSafe request, a browser action or an ambiguous submission.
- Tests use synthetic pages; do not submit a real external form or change global Codex MCP registration.

## File map

- `src/interactive/contracts.ts`: action, snapshot, site policy and result types.
- `src/interactive/snapshot.ts`: pure bounded snapshot and candidate construction, fingerprinting and value exclusion.
- `src/interactive/decision.ts`: TypeSafe choice request and strict response validation.
- `src/interactive/egress-proxy.ts`: local CONNECT proxy that validates origin/DNS and pins each Chrome connection to a public IP.
- `src/interactive/network-policy.ts`: phase-specific request, redirect and one-shot POST routing.
- `src/interactive/browser-driver.ts`: isolated Chrome session, DOM observation, manual login handoff and action execution.
- `src/interactive/session-service.ts`: capacity, budgets, previews, tokens, freshness, cleanup and outcome status.
- `src/interactive/mcp-tools.ts`: five MCP schemas, annotations and fixed public errors.
- `src/mcp/server.ts`, `src/index.ts`: register the new API without modifying old tool behavior.
- `README.md`, `docs/architecture.md`, `docs/threat-model.md`: operator contract and residual risks.
- `test/interactive-*.test.ts`: pure, transport, browser, service and MCP evidence.

---

### Task 1: Bounded interactive candidates

**Files:** Create `src/interactive/contracts.ts`, `src/interactive/snapshot.ts`, `test/interactive-snapshot.test.ts`.

**Interfaces:** `buildInteractiveSnapshot(raw: RawInteractivePage, policy: SitePolicy): InteractiveSnapshot`; each `ActionCandidate` has `{id, kind, label, destination, valueKey?, fingerprint}`. A snapshot keeps `modelText` separate from private form evidence.

- [ ] Write tests first for visible same-origin links, disclosure buttons, fill/select fields, exact POST submit actions, and rejection of hidden, cross-origin, risky, download and unknown-effect controls. Assert candidate IDs and SHA-256 fingerprints are stable, while raw values, passwords and hidden fields never enter `modelText`.
- [ ] Run `npm test -- test/interactive-snapshot.test.ts`; expect failure because the module is absent.
- [ ] Implement the types and pure builder with at most 80 candidates and 3,000 redacted page-text characters. Form evidence includes all control names/values only in a private fingerprint and user preview, with hidden security fields redacted.
- [ ] Run the focused test, `npm run typecheck` and `git diff --check`; expect all exit 0. Commit as `feat: model bounded interactive browser actions`.

### Task 2: Jev action decision

**Files:** Create `src/interactive/decision.ts`, `test/interactive-decision.test.ts`; reuse `createTypeSafeTransport` settings from `src/decision/typesafe-client.ts` without changing its public behavior.

**Interfaces:** `InteractiveJevClient.choose({goal, snapshot, valueKeys}, {signal?})` returns `ready | done | blocked | low_confidence` with usage and the original candidate object. A candidate is selected by one opaque ID, so action type and element cannot be generated by Jev.

- [ ] Write failing tests using an injected transport: the request contains only redacted goal, page labels and opaque value keys; it excludes raw values, password, cookies, query tokens and hidden form data.
- [ ] Run `npm test -- test/interactive-decision.test.ts`; expect missing implementation failure.
- [ ] Add the choice call with `done`, `blocked` and candidate IDs. Validate model `jev-1.13.0`, integer usage, exact probability keys, sum, argmax and effective confidence `min(answer.confidence, selectedProbability) >= 0.80`.
- [ ] Add tests for invented IDs, malformed distributions, low confidence and no candidates; run focused tests and typecheck, then commit as `feat: constrain Jev to interactive action IDs`.

### Task 3: Interactive network boundary

**Files:** Create `src/interactive/egress-proxy.ts`, `src/interactive/network-policy.ts`, `test/interactive-network-policy.test.ts`.

**Interfaces:** `installInteractiveNetworkPolicy(context, page, origins, assertHost?)` returns `NetworkGate` with `enterSupervised()`, `lockAfterValue()`, `approveDocument(url)`, `approveSubmission({method,url})`, `submissionResult()` and `close()`.

- [ ] Write failing tests for HTTPS/public DNS and exact origin checks; manual-login origins only before handoff; GET/HEAD-only supervised requests; no redirects to unknown destinations; blocked private hosts, subframes, downloads, popups and WebSockets. Include an actual browser redirect proving that Playwright does not re-intercept it, while the local CONNECT proxy blocks its unlisted or private target.
- [ ] Run `npm test -- test/interactive-network-policy.test.ts`; expect missing implementation failure.
- [ ] Implement a loopback-only CONNECT proxy that rejects plain HTTP requests, checks the exact allowed host/port and every resolved IP, connects only to a checked public IP and never logs destinations or data. Route Chrome through it. Implement request routing with `route.fetch({maxRedirects:0})`, checked origins and request methods. Supervised POST/PUT/PATCH/DELETE fail closed. After `lockAfterValue`, every request fails closed. `approveSubmission` allows at most one exact HTTPS POST and records whether it may have reached the server; no redirect is treated as confirmed success.
- [ ] Add tests for two POST attempts, unexpected XHR on input/change, redirect after POST and ambiguous response. Run focused tests and typecheck; commit as `feat: enforce interactive browser network phases`.

### Task 4: Playwright interaction adapter

**Files:** Create `src/interactive/browser-driver.ts`, `test/interactive-browser-driver.test.ts`.

**Interfaces:** `InteractiveBrowserDriver.open(OpenBrowserOptions): Promise<InteractiveBrowserSession>`; session supports `snapshot()`, `finishManualLogin()`, `execute(candidate, value?)`, `close()`. Test constructor injection permits a fixture resolver and headless Chrome without weakening production defaults.

- [ ] Write failing browser tests with a synthetic HTTPS page for DOM extraction, JavaScript-enabled disclosure/link actions, blocked popup/download, manual-login handoff and standard form submission.
- [ ] Run `npm test -- test/interactive-browser-driver.test.ts`; expect missing implementation failure.
- [ ] Implement fresh contexts with the existing minimal `browserEnvironment()`, `acceptDownloads:false`, `serviceWorkers:"block"` and `blockWebSockets()`. Auth opens headed Chrome; public opens headless. Use DOM actions only after candidate freshness is rechecked, enforce `siteOrigin`, and always close context/browser on failure.
- [ ] Verify focused tests and typecheck; commit as `feat: add supervised Playwright sessions`.

### Task 5: Preview, approval and lifecycle

**Files:** Create `src/interactive/session-service.ts`, `test/interactive-session-service.test.ts`.

**Interfaces:** `InteractiveSessionService.open(request)`, `preview(sessionId)`, `execute(token)`, `cancel(token)`, `closeSession(sessionId)`, `close()`; constructor injects `InteractiveBrowserDriver`, `InteractiveJevClient`, clock and token factory.

- [ ] Write failing service tests with fake browser/model adapters for no action during preview, exact action/values display, token consumed before execution, stale page/form rejection, token reuse/expiry, session capacity, action/model/time budgets and concurrent shutdown.
- [ ] Run `npm test -- test/interactive-session-service.test.ts`; expect missing implementation failure.
- [ ] Implement session map and one pending token per session, 120-second timer, 15-minute session timer, two-session reservation before browser opening, 20-action and 25-call limits. Terminal decisions close sessions; `done` is `verified_done` only when the caller's exact URL or visible-text postcondition is observed.
- [ ] Run focused tests and typecheck; commit as `feat: add supervised action previews and lifecycle`.

### Task 6: Values and form outcome

**Files:** Modify `src/interactive/{snapshot,network-policy,browser-driver,session-service}.ts`; add `test/interactive-form.test.ts`.

**Interfaces:** `open` stores only non-credential `values: Record<string,string>` in memory. `preview` reveals a selected exact value to the user, never to Jev. `execute` reports `submitted | outcome_unknown | acted`; no retry method exists.

- [ ] Write failing synthetic-form tests for approval before fill, network lock after fill, exact method/destination/payload preview, hidden-field fingerprint changes, no file inputs, one authorized POST, blocked dynamic endpoint without code-owned site policy, and ambiguous response without a second POST.
- [ ] Run `npm test -- test/interactive-form.test.ts`; expect the behavior assertions to fail.
- [ ] Implement pre-fill approval and network lock, private form evidence, exact POST authorization, re-observation before submit and `outcome_unknown` for a request that may have reached the server without proof of completion.
- [ ] Run focused tests, existing browser/service tests and typecheck; commit as `feat: gate form values and exact submissions`.

### Task 7: MCP boundary and operator documentation

**Files:** Create `src/interactive/mcp-tools.ts`, `test/interactive-mcp.test.ts`; modify `src/mcp/server.ts`, `src/index.ts`, `README.md`, `docs/architecture.md`, `docs/threat-model.md`.

**Interfaces:** Register `jev_browser_open`, `jev_browser_preview`, `jev_browser_execute`, `jev_browser_cancel`, `jev_browser_close`. `createMcpServer` accepts an optional interactive API; existing callers continue to get exactly the three old tools.

- [ ] Write failing in-memory MCP tests for all schemas, annotations, stable bounded errors, no secret text in failures and unchanged legacy tool order when interactive API is absent.
- [ ] Run `npm test -- test/interactive-mcp.test.ts`; expect missing tools.
- [ ] Register tools with `zod/v4`: exact HTTPS origins, bounded goal/values, mode, data-sharing opt-in and expected result. Mark `execute` as non-idempotent/destructive; all descriptions assign approval to the trusted client. Wire the service in `src/index.ts` and close it during shutdown.
- [ ] Update docs with real setup, manual login handoff, TypeSafe private-text opt-in, form limits, uncertain outcomes, no real-site activation and the separate residual risks. Run focused tests, documentation tests and typecheck; commit as `feat: expose supervised Jev browser tools`.

### Task 8: Final synthetic verification and review

**Files:** Add `test/interactive-e2e.test.ts` only if the earlier fixture tests do not cover the full preview → execute → preview sequence. Update the plan checkboxes and docs only for verified behavior.

- [ ] Run the complete synthetic public reading and manual-login form workflows with an injected Jev transport. Verify every action has a preview and one consumed token.
- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev`, `git diff --check`, and a local MCP handshake. Record exact pass/fail counts.
- [ ] Review the specification line by line against code and tests. Mark unsupported sites/actions honestly in README and threat model.
- [ ] Confirm no real form was sent, no secret appeared in test output or Git diff, no global MCP config changed, and the working tree contains only intentional files. Commit final verification/docs changes if any.
