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

test("rejects a redirect away from the exact approved destination", async () => {
  const redirected = { ...destination, sourceUrl: "https://example.com/docs?redirected=1" };
  const session = new FakeBrowserSession([page, page], redirected);
  const guard = service(session);
  const preview = await guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;

  await assert.rejects(() => guard.execute(preview.token), /exact approved destination/);
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

test("proactively closes a preview that is never consumed", async () => {
  const store = new SessionStore({ ttlMs: 10 });
  const session = new FakeBrowserSession([page]);
  await store.put({
    browser: session,
    snapshot: page,
    candidate,
    confidence: 0.94,
    usage,
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(session.closed, true);
});

test("shutdown prevents an in-flight preview from retaining a browser", async () => {
  let releaseDecision: ((decision: Decision) => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const decision = new Promise<Decision>((resolve) => {
    releaseDecision = resolve;
  });
  const jev: JevClient = {
    async choose() {
      signalStarted?.();
      return decision;
    },
  };
  const session = new FakeBrowserSession([page]);
  const guard = new GuardService(new FakeDriver([session]), jev, new SessionStore());
  const preview = guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  await started;
  await guard.close();
  assert.equal(session.closed, true, "close must close the browser before the model responds");
  releaseDecision?.(readyDecision());

  await assert.rejects(() => preview, /closed/);
  assert.equal(session.closed, true);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((release) => { resolve = release; });
  return { promise, resolve };
}

test("reserves configured capacity before opening browsers or calling Jev", async () => {
  const decision = deferred<Decision>();
  const started = deferred<void>();
  let opens = 0;
  let choices = 0;
  const guard = new GuardService({ async open() { opens++; return new FakeBrowserSession([page]); } }, {
    async choose() { if (++choices === 3) started.resolve(); return decision.promise; },
  }, new SessionStore({ maxSessions: 3 }));
  const previews = Array.from({ length: 3 }, () => guard.preview({ url: page.sourceUrl, goal: "Read docs" }));
  await started.promise;
  const fourth = guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  decision.resolve({ status: "done", confidence: 1, choice: "done", usage });
  await assert.rejects(fourth, /Too many/);
  await Promise.all(previews);
  assert.equal(opens, 3);
  assert.equal(choices, 3);
  await guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  assert.equal(opens, 4, "terminal decisions release capacity");
  await guard.close();
});

test("shutdown closes a consumed execute while navigation is still pending", async () => {
  const navigation = deferred<PageSnapshot>();
  const started = deferred<void>();
  const session = new FakeBrowserSession([page]);
  session.navigate = async () => { started.resolve(); return navigation.promise; };
  const guard = service(session);
  const preview = await guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  const execution = guard.execute(preview.token);
  await started.promise;
  await guard.close();
  assert.equal(session.closed, true);
  navigation.resolve(destination);
  await assert.rejects(execution, /closed/);
  await assert.rejects(guard.preview({ url: page.sourceUrl, goal: "Read docs" }), /closed/);
  await assert.rejects(guard.execute(preview.token), /closed/);
});

test("shutdown waits for an opening browser and closes it without calling Jev", async () => {
  const opening = deferred<BrowserSession>();
  const started = deferred<void>();
  const session = new FakeBrowserSession([page]);
  let choices = 0;
  const guard = new GuardService({ async open() { started.resolve(); return opening.promise; } }, {
    async choose() { choices++; return readyDecision(); },
  });
  const preview = guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  const rejected = assert.rejects(preview, /closed/);
  await started.promise;
  const closing = guard.close();
  opening.resolve(session);
  await closing;
  assert.equal(session.closed, true);
  await rejected;
  assert.equal(choices, 0);
});

test("keeps consumed executions within capacity until their browsers close", async () => {
  const navigation = deferred<PageSnapshot>();
  const started = deferred<void>();
  const session = new FakeBrowserSession([page]);
  session.navigate = async () => { started.resolve(); return navigation.promise; };
  const next = new FakeBrowserSession([page]);
  const guard = new GuardService(new FakeDriver([session, next]), new FakeJev(readyDecision()), new SessionStore({ maxSessions: 1 }));
  const preview = await guard.preview({ url: page.sourceUrl, goal: "Read docs" });
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  const execution = guard.execute(preview.token);
  await started.promise;
  await assert.rejects(guard.preview({ url: page.sourceUrl, goal: "Read docs" }), /Too many/);
  navigation.resolve(destination);
  await execution;
  assert.equal((await guard.preview({ url: page.sourceUrl, goal: "Read docs" })).status, "ready");
  await guard.close();
});

test("releases reservations after browser and model errors", async () => {
  let opens = 0;
  let choices = 0;
  const sessions: FakeBrowserSession[] = [];
  const guard = new GuardService({ async open() {
    if (++opens === 1) throw new Error("open failed");
    const session = new FakeBrowserSession([page]);
    sessions.push(session);
    return session;
  } }, { async choose() {
    if (++choices === 1) throw new Error("model failed");
    return readyDecision();
  } }, new SessionStore({ maxSessions: 1 }));
  await assert.rejects(guard.preview({ url: page.sourceUrl, goal: "Read docs" }), /open failed/);
  await assert.rejects(guard.preview({ url: page.sourceUrl, goal: "Read docs" }), /model failed/);
  assert.equal(sessions[0]?.closed, true);
  assert.equal((await guard.preview({ url: page.sourceUrl, goal: "Read docs" })).status, "ready");
  await guard.close();
  assert.equal(sessions[1]?.closed, true);
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
