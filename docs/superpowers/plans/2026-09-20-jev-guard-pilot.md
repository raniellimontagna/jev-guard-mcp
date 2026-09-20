# Jev Guard Browser Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local MCP server that lets Codex ask Jev to choose one public, same-origin browser navigation, preview it, and execute it only through a short-lived single-use token.

**Architecture:** Codex owns task planning, Jev chooses among a bounded list of links, and deterministic TypeScript owns URL policy, isolation, freshness, execution, and postcondition checks. The pilot launches a fresh Chrome context without user profile data, sends only redacted text and link metadata to TypeSafe, and never types, submits forms, downloads files, clicks buttons, or accesses private-network destinations.

**Tech Stack:** Node.js 22+, TypeScript ESM, MCP TypeScript SDK, TypeSafe SDK, Playwright using the installed Chrome channel, Node test runner through `tsx`.

## Global Constraints

- Work in `/Users/raniellimontagna/Projetos/pessoal/jev-guard-mcp`, never inside the Obsidian vault.
- Keep the implementation on branch `codex/jev-guard-pilot`; do not publish or register it globally during this plan.
- Read `TYPESAFE_API_KEY` only from the process environment or macOS Keychain service `typesafe-api-key`; never load workspace `.env` files and never store the key.
- Pin every direct dependency to an exact version and pin the Jev model to `jev-1.13.0`.
- Permit only `https:` URLs with no embedded credentials and public DNS results.
- Candidate actions are visible same-origin anchors with no query string, no download attribute, and no risky path term.
- The browser context is fresh, has no saved profile, blocks service workers, rejects downloads, closes popups, and holds at most one pending action per session.
- Jev never creates a URL, selector, coordinate, script, or typed value; it only selects a key from code-created criteria.
- Minimum confidence is `0.80`; below it, no executable token is returned.
- Execution tokens expire after 120 seconds, are stored only in memory, and are consumed before any action.
- Execution re-observes the page and requires the exact source URL, candidate ID, label, and destination to match the preview.
- The pilot performs navigation with `page.goto()` rather than dispatching a page click, avoiding page-provided click handlers.
- TypeSafe requests have zero automatic retries, a 10-second attempt timeout, and are counted before the request starts.
- No screenshots, raw HTML, input values, cookies, local storage, query strings, or full URLs are sent to TypeSafe or persisted.

---

### Task 1: Project foundation and security contracts

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/contracts.ts`
- Create: `src/security/url-policy.ts`
- Test: `test/url-policy.test.ts`

**Interfaces:**
- Produces: `validateStartUrl(raw: string): URL`, `candidateUrl(base: URL, href: string, download: boolean): URL | null`, `assertPublicHostname(hostname: string, lookup?: Lookup): Promise<void>`.

- [x] **Step 1: Add the pinned package metadata, strict TypeScript configuration, and ignore rules needed to run tests**
- [x] **Step 2: Write failing URL-policy tests**

```ts
test("accepts a public HTTPS start URL and strips nothing locally", () => {
  assert.equal(validateStartUrl("https://example.com/docs").href, "https://example.com/docs");
});

test("rejects localhost, credentials, HTTP, query candidates, cross-origin links and risky paths", () => {
  assert.throws(() => validateStartUrl("https://localhost/private"));
  assert.throws(() => validateStartUrl("https://user:pass@example.com/"));
  assert.throws(() => validateStartUrl("http://example.com/"));
  const base = new URL("https://example.com/start");
  assert.equal(candidateUrl(base, "https://example.com/search?q=x", false), null);
  assert.equal(candidateUrl(base, "https://other.example/path", false), null);
  assert.equal(candidateUrl(base, "/logout", false), null);
  assert.equal(candidateUrl(base, "/report.pdf", true), null);
});
```

- [x] **Step 3: Run `npm test -- test/url-policy.test.ts` and verify failure because the module is absent**
- [x] **Step 4: Add contracts, URL parsing, risky-path denylist, `node:net` private-range blocking, and injectable DNS lookup**
- [x] **Step 5: Run the focused test and verify it passes**
- [x] **Step 6: Commit with `git commit -m "feat: establish Jev Guard security contracts"`**

### Task 2: Redacted snapshots and bounded candidates

**Files:**
- Create: `src/security/redaction.ts`
- Create: `src/browser/snapshot.ts`
- Test: `test/redaction.test.ts`
- Test: `test/snapshot.test.ts`

**Interfaces:**
- Consumes: `candidateUrl()` from Task 1.
- Produces: `redactText(value: string): string`, `buildSnapshot(raw: RawPageSnapshot): PageSnapshot`.

- [x] **Step 1: Write failing tests proving e-mails, phone numbers, bearer-like tokens, repeated whitespace and URL queries are removed**

```ts
test("redacts sensitive text", () => {
  assert.equal(
    redactText("Contact me@example.com or +55 51 99999-0000 token abcdefghijklmnopqrstuvwxyz123"),
    "Contact [REDACTED_EMAIL] or [REDACTED_PHONE] token [REDACTED_TOKEN]",
  );
});
```

- [x] **Step 2: Run the focused redaction test and verify the missing-module failure**
- [x] **Step 3: Implement minimal redaction and rerun until green**
- [x] **Step 4: Write failing snapshot tests that retain at most 80 visible safe anchors, normalize labels, expose only origin/path, and create stable SHA-256 candidate fingerprints**
- [x] **Step 5: Implement `buildSnapshot()` as a pure function and verify both test files pass**
- [x] **Step 6: Commit with `git commit -m "feat: build bounded redacted page snapshots"`**

### Task 3: Jev decision boundary

**Files:**
- Create: `src/decision/jev-client.ts`
- Create: `src/decision/typesafe-client.ts`
- Test: `test/jev-client.test.ts`

**Interfaces:**
- Consumes: `PageSnapshot`.
- Produces: `JevClient.choose(input: DecisionInput): Promise<Decision>` and `TypeSafeJevClient`.

- [x] **Step 1: Write a failing test with an injected transport showing that only `done`, `blocked`, and code-created candidate IDs are accepted**

```ts
test("rejects an answer outside the bounded choice set", async () => {
  const client = new TypeSafeJevClient(async () => answer("invented", 0.99));
  await assert.rejects(() => client.choose(input), /outside the offered action set/);
});
```

- [x] **Step 2: Run the focused test and verify failure because the decision module is absent**
- [x] **Step 3: Implement the choice question, exact `jev-1.13.0` model, confidence parsing, and attempt counter incremented before transport invocation**
- [x] **Step 4: Add failing tests for confidence below `0.80`, missing candidates, malformed probabilities, timeout propagation, and terminal decisions**
- [x] **Step 5: Implement the minimal validation and configure the real SDK client with hard-coded TypeSafe base URL, `maxRetries: 0`, `timeout: 10_000`, and logging off**
- [x] **Step 6: Run the complete decision test file and commit with `git commit -m "feat: constrain Jev to bounded navigation choices"`**

### Task 4: Browser isolation and network enforcement

**Files:**
- Create: `src/browser/browser-driver.ts`
- Create: `src/browser/playwright-driver.ts`
- Test: `test/playwright-driver.test.ts`

**Interfaces:**
- Produces: `BrowserDriver.open(url): Promise<BrowserSession>`; a session supports `snapshot()`, `navigate(url)`, and `close()`.

- [x] **Step 1: Write a failing Playwright test that loads static HTML with `page.setContent()` and proves hidden, query-bearing, cross-origin, download and risky anchors are excluded**
- [x] **Step 2: Run it and verify failure because the driver does not exist**
- [x] **Step 3: Implement Chrome-channel launch, fresh context, blocked service workers/downloads/popups, request routing through the public-host policy, and DOM extraction limited to visible anchors**
- [x] **Step 4: Add a failing test showing input values and raw HTML never appear in the snapshot**
- [x] **Step 5: Implement snapshot extraction and verify the focused test file passes**
- [x] **Step 6: Commit with `git commit -m "feat: add isolated Playwright observer"`**

### Task 5: Preview, single-use execution, and freshness

**Files:**
- Create: `src/guard/guard-service.ts`
- Create: `src/guard/session-store.ts`
- Test: `test/guard-service.test.ts`

**Interfaces:**
- Consumes: `BrowserDriver` and `JevClient`.
- Produces: `GuardService.preview({url, goal})`, `GuardService.execute(token)`, and `GuardService.cancel(token)`.

- [x] **Step 1: Write failing tests using in-memory fake browser and Jev adapters for preview-only terminal/low-confidence decisions**
- [x] **Step 2: Run the focused tests and verify the missing-service failure**
- [x] **Step 3: Implement preview with a maximum of three live sessions, 120-second expiry, and cryptographically random opaque tokens**
- [x] **Step 4: Write failing tests proving execution consumes the token before navigation, rejects reuse/expiry, and closes the browser on every terminal path**
- [x] **Step 5: Implement single-use execution and cancellation**
- [x] **Step 6: Write failing tests proving changed source URL, missing candidate, changed label, changed destination or changed fingerprint are rejected as stale**
- [x] **Step 7: Implement exact freshness matching, deterministic `page.goto()`, same-origin postcondition checking, and redacted final output**
- [x] **Step 8: Run all guard tests and commit with `git commit -m "feat: enforce preview and single-use navigation"`**

### Task 6: MCP tools and Keychain launcher

**Files:**
- Create: `src/mcp/server.ts`
- Create: `src/index.ts`
- Create: `scripts/run-from-keychain.sh`
- Test: `test/mcp-server.test.ts`

**Interfaces:**
- Consumes: `GuardService`.
- Produces MCP tools `jev_guard_preview`, `jev_guard_execute`, and `jev_guard_cancel` over stdio.

- [ ] **Step 1: Write a failing in-memory MCP client test asserting the three tool schemas, annotations, and structured error responses**
- [ ] **Step 2: Run the focused test and verify failure because the MCP server is absent**
- [ ] **Step 3: Implement tools with Zod schemas; describe preview as non-mutating and require a token for execute/cancel**
- [ ] **Step 4: Implement the stdio entry point with no stdout logging and fail closed when the API key is absent**
- [ ] **Step 5: Add a Keychain launcher that obtains `typesafe-api-key` only when the environment lacks `TYPESAFE_API_KEY`, exports it without printing it, and execs `node dist/index.js`**
- [ ] **Step 6: Verify MCP tests, `npm run typecheck`, and `npm run build`; commit with `git commit -m "feat: expose guarded navigation over MCP"`**

### Task 7: Threat model, operator guide, and bounded live smoke test

**Files:**
- Create: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/threat-model.md`
- Create: `scripts/smoke-live.ts`
- Test: `test/documentation.test.ts`

**Interfaces:**
- Documents the trust boundary, remaining DNS-rebinding/GET-side-effect risks, data sent to TypeSafe, and the later Codex registration command without applying it.

- [ ] **Step 1: Write a failing documentation test requiring the safety boundary, prohibited actions, data-flow statement, Keychain launcher, residual risks, and explicit non-registration status**
- [ ] **Step 2: Run it and verify failure because the documents are absent**
- [ ] **Step 3: Write the README, architecture document, and threat model with exact setup and verification commands**
- [ ] **Step 4: Add a live smoke script that defaults to preview-only and executes one Wikipedia same-origin link only with explicit `--execute`**
- [ ] **Step 5: Run `npm test`, `npm run typecheck`, `npm run build`, `npm audit --omit=dev`, and `npm pack --dry-run`**
- [ ] **Step 6: Run the preview-only live smoke test using the existing Keychain-backed TypeSafe credential; report attempts, tokens, selected action, confidence, and browser closure without printing secrets**
- [ ] **Step 7: Review every Global Constraint against code/tests, inspect `git diff --check` and `git status --short`, then commit with `git commit -m "docs: document Jev Guard pilot boundaries"`**
