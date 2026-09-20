import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserDriver, BrowserSession } from "../src/browser/browser-driver.js";
import type { LinkCandidate, PageSnapshot } from "../src/contracts.js";
import type { Decision, JevClient } from "../src/decision/jev-client.js";
import { GuardService } from "../src/guard/guard-service.js";
import { SessionStore } from "../src/guard/session-store.js";

const candidate: LinkCandidate = {
  id: "link_0",
  label: "Documentation",
  url: "https://example.com/docs",
  publicUrl: "https://example.com/docs",
  fingerprint: "a".repeat(64),
};

const page: PageSnapshot = {
  sourceUrl: "https://example.com/start?private=1",
  publicUrl: "https://example.com/start",
  title: "Start",
  text: "Public start page",
  candidates: [candidate],
};

const destination: PageSnapshot = {
  sourceUrl: "https://example.com/docs",
  publicUrl: "https://example.com/docs",
  title: "Docs",
  text: "Documentation page",
  candidates: [],
};

const usage = { attempts: 1, inputTokens: 100, outputTokens: 20, model: "jev-1.13.0" };

class FakeBrowserSession implements BrowserSession {
  closed = false;
  navigateCalls: string[] = [];
  snapshotCalls = 0;

  constructor(
    readonly snapshots: PageSnapshot[],
    readonly navigationResult = destination,
    readonly navigationError?: Error,
  ) {}

  async snapshot(): Promise<PageSnapshot> {
    const value = this.snapshots[Math.min(this.snapshotCalls, this.snapshots.length - 1)];
    this.snapshotCalls += 1;
    if (!value) throw new Error("No fake snapshot configured");
    return value;
  }

  async navigate(url: string): Promise<PageSnapshot> {
    this.navigateCalls.push(url);
    if (this.navigationError) throw this.navigationError;
    return this.navigationResult;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeDriver implements BrowserDriver {
  constructor(readonly sessions: FakeBrowserSession[]) {}

  async open(): Promise<BrowserSession> {
    const session = this.sessions.shift();
    if (!session) throw new Error("No fake browser session configured");
    return session;
  }
}

class FakeJev implements JevClient {
  constructor(readonly decision: Decision) {}
  async choose(): Promise<Decision> {
    return this.decision;
  }
}

function readyDecision(): Decision {
  return { status: "ready", confidence: 0.94, choice: candidate.id, candidate, usage };
}

function service(
  session: FakeBrowserSession,
  decision: Decision = readyDecision(),
  store = new SessionStore(),
): GuardService {
  return new GuardService(new FakeDriver([session]), new FakeJev(decision), store);
}

test("closes the browser and returns no token for terminal and low-confidence decisions", async () => {
  for (const decision of [
    { status: "done", confidence: 0.91, choice: "done", usage } as const,
    { status: "blocked", confidence: 0.92, choice: "blocked", usage } as const,
    { status: "low_confidence", confidence: 0.42, choice: "link_0", usage } as const,
  ]) {
    const session = new FakeBrowserSession([page]);
    const result = await service(session, decision).preview({ url: page.sourceUrl, goal: "Read docs" });
    assert.equal(result.status, decision.status);
    assert.equal("token" in result, false);
    assert.equal(session.closed, true);
  }
});

test("returns a short-lived preview token without exposing the query string", async () => {
  const session = new FakeBrowserSession([page]);
  const result = await service(session).preview({ url: page.sourceUrl, goal: "Read docs" });

  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.sourceUrl, page.publicUrl);
  assert.equal(result.action.destination, candidate.publicUrl);
  assert.doesNotMatch(JSON.stringify(result), /private=1/);
  assert.ok(result.token.length >= 32);
  assert.equal(session.closed, false);
});

test("executes once, closes the browser and rejects token reuse", async () => {
  const session = new FakeBrowserSession([page, page]);
  const guard = service(session);
  const preview = await guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;

  const result = await guard.execute(preview.token);
  assert.equal(result.status, "navigated");
  assert.equal(result.page.url, destination.publicUrl);
  assert.deepEqual(session.navigateCalls, [candidate.url]);
  assert.equal(session.closed, true);
  await assert.rejects(() => guard.execute(preview.token), /invalid or already consumed/);
});

test("consumes the token before a failed navigation", async () => {
  const session = new FakeBrowserSession([page, page], destination, new Error("navigation failed"));
  const guard = service(session);
  const preview = await guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;

  await assert.rejects(() => guard.execute(preview.token), /navigation failed/);
  await assert.rejects(() => guard.execute(preview.token), /invalid or already consumed/);
  assert.equal(session.closed, true);
});

test("rejects and closes expired tokens", async () => {
  let now = 1_000;
  const store = new SessionStore({ now: () => now, tokenFactory: () => "t".repeat(43) });
  const session = new FakeBrowserSession([page]);
  const guard = service(session, readyDecision(), store);
  const preview = await guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  now += 120_001;

  await assert.rejects(() => guard.execute(preview.token), /expired/);
  assert.equal(session.closed, true);
});

test("cancel consumes the token and closes its browser", async () => {
  const session = new FakeBrowserSession([page]);
  const guard = service(session);
  const preview = await guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;

  assert.deepEqual(await guard.cancel(preview.token), { status: "cancelled" });
  assert.equal(session.closed, true);
  await assert.rejects(() => guard.cancel(preview.token), /invalid or already consumed/);
});

const staleCases: Array<[string, PageSnapshot]> = [
  ["source URL", { ...page, sourceUrl: "https://example.com/other" }],
  ["candidate removal", { ...page, candidates: [] }],
  ["candidate label", { ...page, candidates: [{ ...candidate, label: "Changed" }] }],
  ["candidate destination", { ...page, candidates: [{ ...candidate, url: "https://example.com/changed" }] }],
  ["candidate fingerprint", { ...page, candidates: [{ ...candidate, fingerprint: "b".repeat(64) }] }],
];

for (const [name, changed] of staleCases) {
  test(`rejects stale ${name} before navigation`, async () => {
    const session = new FakeBrowserSession([page, changed]);
    const guard = service(session);
    const preview = await guard.preview({ url: page.sourceUrl, goal: "Read docs" });
    assert.equal(preview.status, "ready");
    if (preview.status !== "ready") return;

    await assert.rejects(() => guard.execute(preview.token), /stale/);
    assert.equal(session.navigateCalls.length, 0);
    assert.equal(session.closed, true);
  });
}
