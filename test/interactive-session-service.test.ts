import assert from "node:assert/strict";
import test from "node:test";

import { buildInteractiveSnapshot } from "../src/interactive/snapshot.js";
import { InteractiveSessionService } from "../src/interactive/session-service.js";
import type { InteractiveBrowserSession, BrowserExecutionResult } from "../src/interactive/browser-driver.js";
import type { ActionCandidate, InteractiveSnapshot } from "../src/interactive/contracts.js";
import type { InteractiveDecision } from "../src/interactive/decision.js";

const origins = { siteOrigin: "https://example.com", authOrigins: [], resourceOrigins: [] };
const usage = { attempts: 1, inputTokens: 20, outputTokens: 2, model: "jev-1.13.0" };

function page(url = "https://example.com/start", label = "Next"): InteractiveSnapshot {
  return buildInteractiveSnapshot({
    url, title: url.endsWith("/next") ? "Next page" : "Start page", text: "Read this page",
    elements: url.endsWith("/next") ? [] : [{ domIndex: 0, kind: "link", label, visible: true, enabled: true, href: "/next" }],
  }, { siteOrigin: origins.siteOrigin });
}

class FakeBrowser implements InteractiveBrowserSession {
  current = page();
  executeCalls = 0;
  closed = false;
  loginReady = true;
  async snapshot() { return this.current; }
  async finishManualLogin() { return this.loginReady; }
  async execute(_candidate: ActionCandidate): Promise<BrowserExecutionResult> {
    this.executeCalls += 1;
    this.current = page("https://example.com/next");
    return { status: "acted", snapshot: this.current };
  }
  async close() { this.closed = true; }
}

function readyJev() {
  let calls = 0;
  return {
    get calls() { return calls; },
    async choose(input: { snapshot: InteractiveSnapshot }) {
      calls += 1;
      const candidate = input.snapshot.candidates[0];
      assert.ok(candidate);
      return { status: "ready" as const, candidate, confidence: 0.92, choice: candidate.id, usage };
    },
  };
}

test("preview is inert and one token executes exactly one fresh action", async (context) => {
  const browser = new FakeBrowser();
  const jev = readyJev();
  const service = new InteractiveSessionService({ open: async () => browser }, jev);
  context.after(() => service.close());
  const opened = await service.open({ url: "https://example.com/start", goal: "Read next", mode: "public", origins, values: {} });
  const preview = await service.preview(opened.sessionId);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  assert.equal(browser.executeCalls, 0);
  assert.equal(preview.sourceUrl, "https://example.com/start");
  assert.deepEqual(preview.action, { id: "action_0", kind: "navigate", label: "Next", destination: "https://example.com/next" });
  assert.equal(preview.confidence, 0.92);
  const result = await service.execute(preview.token);
  assert.equal(result.status, "acted");
  assert.equal(result.page.url, "https://example.com/next");
  assert.equal(browser.executeCalls, 1);
  await assert.rejects(() => service.execute(preview.token), /invalid|consumed/i);
});

test("stale action consumes the token and closes the browser", async (context) => {
  const browser = new FakeBrowser();
  const service = new InteractiveSessionService({ open: async () => browser }, readyJev());
  context.after(() => service.close());
  const opened = await service.open({ url: "https://example.com/start", goal: "Read next", mode: "public", origins, values: {} });
  const preview = await service.preview(opened.sessionId);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  browser.current = page("https://example.com/start", "Changed label");
  await assert.rejects(() => service.execute(preview.token), /stale/i);
  assert.equal(browser.executeCalls, 0);
  assert.equal(browser.closed, true);
  await assert.rejects(() => service.execute(preview.token), /invalid|consumed/i);
});

test("authenticated page text needs opt-in and manual login before Jev", async (context) => {
  const browser = new FakeBrowser();
  browser.loginReady = false;
  const jev = readyJev();
  const service = new InteractiveSessionService({ open: async () => browser }, jev);
  context.after(() => service.close());
  await assert.rejects(() => service.open({ url: "https://example.com/start", goal: "Read", mode: "auth", origins, values: {} }), /opt-in|sharing/i);
  const opened = await service.open({ url: "https://example.com/start", goal: "Read", mode: "auth", origins, values: {}, shareRedactedPageTextWithTypeSafe: true });
  assert.equal((await service.preview(opened.sessionId)).status, "login_required");
  assert.equal(jev.calls, 0);
  browser.loginReady = true;
  assert.equal((await service.preview(opened.sessionId)).status, "ready");
  assert.equal(jev.calls, 1);
});

test("expired approval closes the session without executing", async (context) => {
  let now = 1_000;
  const browser = new FakeBrowser();
  const service = new InteractiveSessionService({ open: async () => browser }, readyJev(), { now: () => now });
  context.after(() => service.close());
  const opened = await service.open({ url: "https://example.com/start", goal: "Read next", mode: "public", origins, values: {} });
  const preview = await service.preview(opened.sessionId);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  now += 120_000;
  await assert.rejects(() => service.execute(preview.token), /expired/i);
  assert.equal(browser.executeCalls, 0);
  assert.equal(browser.closed, true);
});

test("reserves two session slots before asynchronous browser opening", async (context) => {
  const releases: Array<(browser: FakeBrowser) => void> = [];
  const service = new InteractiveSessionService({
    open: async () => new Promise<FakeBrowser>((resolve) => { releases.push(resolve); }),
  }, readyJev());
  context.after(() => service.close());
  const request = { url: "https://example.com/start", goal: "Read next", mode: "public" as const, origins, values: {} };
  const first = service.open(request);
  const second = service.open(request);
  await assert.rejects(() => service.open(request), /capacity/i);
  assert.equal(releases.length, 2);
  releases[0]!(new FakeBrowser());
  releases[1]!(new FakeBrowser());
  await Promise.all([first, second]);
});

test("done is verified only against a caller-supplied observable result", async (context) => {
  const browsers = [new FakeBrowser(), new FakeBrowser()];
  const service = new InteractiveSessionService({ open: async () => browsers.shift()! }, {
    async choose() { return { status: "done" as const, choice: "done", confidence: 0.93, usage }; },
  });
  context.after(() => service.close());
  const base = { url: "https://example.com/start", goal: "Read", mode: "public" as const, origins, values: {} };
  const first = await service.open(base);
  assert.equal((await service.preview(first.sessionId)).status, "done_unverified");
  const second = await service.open({ ...base, expectedResult: { kind: "url", value: "https://example.com/start" } });
  assert.equal((await service.preview(second.sessionId)).status, "verified_done");
});

test("does not run two Jev decisions concurrently for one session", async (context) => {
  let release: ((decision: InteractiveDecision) => void) | undefined;
  let observed: InteractiveSnapshot | undefined;
  let calls = 0;
  const jev = { choose: async (input: { snapshot: InteractiveSnapshot }) => {
    observed = input.snapshot;
    calls += 1;
    if (calls === 1) return new Promise<InteractiveDecision>((resolve) => { release = resolve; });
    const candidate = input.snapshot.candidates[0]!;
    return { status: "ready" as const, candidate, choice: candidate.id, confidence: 0.9, usage };
  } };
  const service = new InteractiveSessionService({ open: async () => new FakeBrowser() }, jev);
  context.after(() => service.close());
  const opened = await service.open({ url: "https://example.com/start", goal: "Read", mode: "public", origins, values: {} });
  const first = service.preview(opened.sessionId);
  const second = service.preview(opened.sessionId);
  await Promise.resolve();
  assert.ok(release && observed);
  const candidate = observed.candidates[0]!;
  release({ status: "ready", candidate, choice: candidate.id, confidence: 0.9, usage });
  assert.equal((await first).status, "ready");
  await assert.rejects(second, /busy/i);
  assert.equal(calls, 1);
});

test("shutdown during a model call cannot return an executable token", async () => {
  let release: ((decision: InteractiveDecision) => void) | undefined;
  let observed: InteractiveSnapshot | undefined;
  const browser = new FakeBrowser();
  const service = new InteractiveSessionService({ open: async () => browser }, {
    choose: async (input: { snapshot: InteractiveSnapshot }) => {
      observed = input.snapshot;
      return new Promise<InteractiveDecision>((resolve) => { release = resolve; });
    },
  });
  const opened = await service.open({ url: "https://example.com/start", goal: "Read", mode: "public", origins, values: {} });
  const preview = service.preview(opened.sessionId);
  await Promise.resolve();
  assert.ok(release && observed);
  const closing = service.close();
  const candidate = observed.candidates[0]!;
  release({ status: "ready", candidate, choice: candidate.id, confidence: 0.9, usage });
  await assert.rejects(preview, /closed/i);
  await closing;
  assert.equal(browser.closed, true);
});

test("action and model-call budgets stop the session before another decision", async (context) => {
  const browser = new FakeBrowser();
  browser.execute = async () => { browser.executeCalls += 1; return { status: "acted", snapshot: browser.current }; };
  const jev = readyJev();
  const service = new InteractiveSessionService({ open: async () => browser }, jev, { maxActions: 1, maxModelCalls: 1 });
  context.after(() => service.close());
  const opened = await service.open({ url: "https://example.com/start", goal: "Read", mode: "public", origins, values: {} });
  const preview = await service.preview(opened.sessionId);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  await service.execute(preview.token);
  assert.equal((await service.preview(opened.sessionId)).status, "blocked");
  assert.equal(jev.calls, 1);
  assert.equal(browser.closed, true);
});

test("shutdown during browser execution cannot report an action as completed", async () => {
  const browser = new FakeBrowser();
  let release: ((result: BrowserExecutionResult) => void) | undefined;
  browser.execute = async () => new Promise<BrowserExecutionResult>((resolve) => { release = resolve; });
  const service = new InteractiveSessionService({ open: async () => browser }, readyJev());
  const opened = await service.open({ url: "https://example.com/start", goal: "Read next", mode: "public", origins, values: {} });
  const preview = await service.preview(opened.sessionId);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  const executing = service.execute(preview.token);
  await Promise.resolve();
  assert.ok(release);
  const closing = service.close();
  release({ status: "acted", snapshot: page("https://example.com/next") });
  await assert.rejects(executing, /closed/i);
  await closing;
  assert.equal(browser.closed, true);
});

test("a second preview cannot run while the approved browser action executes", async (context) => {
  const browser = new FakeBrowser();
  let release: ((result: BrowserExecutionResult) => void) | undefined;
  browser.execute = async () => new Promise<BrowserExecutionResult>((resolve) => { release = resolve; });
  const jev = readyJev();
  const service = new InteractiveSessionService({ open: async () => browser }, jev);
  context.after(() => service.close());
  const opened = await service.open({ url: "https://example.com/start", goal: "Read", mode: "public", origins, values: {} });
  const preview = await service.preview(opened.sessionId);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  const executing = service.execute(preview.token);
  await Promise.resolve();
  assert.ok(release);
  await assert.rejects(() => service.preview(opened.sessionId), /busy/i);
  assert.equal(jev.calls, 1);
  release({ status: "acted", snapshot: page("https://example.com/next") });
  assert.equal((await executing).status, "acted");
});

test("a failed page observation closes the session", async (context) => {
  const browser = new FakeBrowser();
  browser.snapshot = async () => { throw new Error("page inspection failed"); };
  const service = new InteractiveSessionService({ open: async () => browser }, readyJev());
  context.after(() => service.close());
  const opened = await service.open({ url: "https://example.com/start", goal: "Read", mode: "public", origins, values: {} });
  await assert.rejects(() => service.preview(opened.sessionId), /page inspection failed/);
  assert.equal(browser.closed, true);
});
