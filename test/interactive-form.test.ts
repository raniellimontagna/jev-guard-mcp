import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InteractiveBrowserDriver } from "../src/interactive/browser-driver.js";
import type { InteractiveBrowserSession } from "../src/interactive/browser-driver.js";
import type { InteractiveSnapshot } from "../src/interactive/contracts.js";
import { EgressProxy } from "../src/interactive/egress-proxy.js";
import { InteractiveSessionService } from "../src/interactive/session-service.js";
import { buildInteractiveSnapshot } from "../src/interactive/snapshot.js";

const origins = { siteOrigin: "https://example.com", authOrigins: [], resourceOrigins: [] };
const usage = { attempts: 1, inputTokens: 20, outputTokens: 2, model: "jev-1.13.0" };
const start = "https://example.com/start";

test("fill preview shows the exact private value and Jev never receives it", async (context) => {
  const secretValue = "hello private customer";
  let current = buildInteractiveSnapshot({
    url: start, title: "Form", text: "Enter a message", elements: [
      { domIndex: 0, kind: "field", label: "Message", visible: true, enabled: true, name: "message", fieldType: "text" },
    ],
  }, { siteOrigin: origins.siteOrigin }, ["message_value"]);
  const executions: Array<{ value: string | undefined }> = [];
  let closed = false;
  const browser: InteractiveBrowserSession = {
    snapshot: async () => current,
    finishManualLogin: async () => true,
    execute: async (_candidate, value) => {
      executions.push({ value });
      current = { ...current, modelText: `The page says ${secretValue}` };
      return { status: "acted", snapshot: current };
    },
    close: async () => { closed = true; },
  };
  const jev = {
    choose: async (input: { snapshot: InteractiveSnapshot }) => {
      assert.doesNotMatch(JSON.stringify(input.snapshot.modelActions), /hello private customer/);
      assert.doesNotMatch(input.snapshot.modelText, /hello private customer/);
      const candidate = input.snapshot.candidates[0]!;
      return { status: "ready" as const, candidate, choice: candidate.id, confidence: 0.92, usage };
    },
  };
  const service = new InteractiveSessionService({ open: async () => browser }, jev);
  context.after(() => service.close());
  const opened = await service.open({ url: start, goal: "Fill message", mode: "public", origins, values: { message_value: secretValue } });
  const preview = await service.preview(opened.sessionId);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  assert.deepEqual(executions, []);
  assert.equal(preview.action.kind, "fill");
  assert.equal(preview.action.value, secretValue);
  assert.equal(preview.action.destination, start);
  const result = await service.execute(preview.token);
  assert.deepEqual(executions, [{ value: secretValue }]);
  assert.doesNotMatch(result.page.text, /hello private customer/);
  assert.equal(closed, false);
  const second = await service.preview(opened.sessionId);
  assert.equal(second.status, "ready");
  if (second.status === "ready") await service.cancel(second.token);
});

test("rejects credential-looking value keys before opening a browser", async () => {
  let opened = false;
  const service = new InteractiveSessionService({ open: async () => { opened = true; throw new Error("should not open"); } }, {
    choose: async () => { throw new Error("should not call Jev"); },
  });
  await assert.rejects(() => service.open({ url: start, goal: "Fill", mode: "public", origins, values: { account_password: "SYNTHETIC" } }), /invalid|credential/i);
  assert.equal(opened, false);
});

test("submit preview shows exact payload with hidden values redacted and detects stale token", async (context) => {
  let csrf = "SYNTHETIC_HIDDEN_CSRF";
  const snapshot = () => buildInteractiveSnapshot({
    url: start, title: "Form", text: "Ready", elements: [{
      domIndex: 0, kind: "submit", label: "Send inquiry", visible: true, enabled: true,
      form: { action: "https://example.com/inquiries", method: "POST", hasFileInput: false,
        fields: [{ name: "message", value: "Hello", hidden: false }, { name: "csrf", value: csrf, hidden: true, type: "hidden" }] },
    }],
  }, { siteOrigin: origins.siteOrigin });
  let executeCount = 0;
  let closed = false;
  const browser: InteractiveBrowserSession = {
    snapshot: async () => snapshot(),
    finishManualLogin: async () => true,
    execute: async () => { executeCount += 1; return { status: "submitted", snapshot: snapshot() }; },
    close: async () => { closed = true; },
  };
  const service = new InteractiveSessionService({ open: async () => browser }, {
    choose: async ({ snapshot: observed }: { snapshot: InteractiveSnapshot }) => {
      const candidate = observed.candidates[0]!;
      return { status: "ready" as const, candidate, choice: candidate.id, confidence: 0.92, usage };
    },
  });
  context.after(() => service.close());
  const opened = await service.open({ url: start, goal: "Submit", mode: "public", origins, values: {} });
  const preview = await service.preview(opened.sessionId);
  assert.equal(preview.status, "ready");
  if (preview.status !== "ready") return;
  assert.equal(preview.action.kind, "submit");
  assert.equal(preview.action.destination, "https://example.com/inquiries");
  assert.equal(preview.action.method, "POST");
  assert.deepEqual(preview.action.fields, [
    { name: "message", value: "Hello" }, { name: "csrf", value: "[HIDDEN]" },
  ]);
  assert.doesNotMatch(JSON.stringify(preview), /SYNTHETIC_HIDDEN_CSRF/);
  csrf = "CHANGED_HIDDEN_CSRF";
  await assert.rejects(() => service.execute(preview.token), /stale/i);
  assert.equal(executeCount, 0);
  assert.equal(closed, true);
});

test("rejects unsupported form encodings, targets, named submitters and file inputs", () => {
  const base = {
    url: start, title: "Form", text: "", elements: [{ domIndex: 0, kind: "submit" as const,
      label: "Send", visible: true, enabled: true, form: {
        action: "https://example.com/inquiries", method: "POST", hasFileInput: false,
        enctype: "application/x-www-form-urlencoded", target: "_self", submitterName: "",
        fields: [{ name: "message", value: "Hello", hidden: false }],
      } }],
  };
  for (const formPatch of [
    { enctype: "multipart/form-data" }, { target: "_blank" }, { submitterName: "action" }, { hasFileInput: true },
  ]) {
    const raw = { ...base, elements: [{ ...base.elements[0]!, form: { ...base.elements[0]!.form, ...formPatch } }] };
    assert.deepEqual(buildInteractiveSnapshot(raw, { siteOrigin: origins.siteOrigin }).candidates, []);
  }
});

async function fixture(
  handler: Parameters<typeof createServer>[1],
): Promise<{ driver: InteractiveBrowserDriver; close: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "jev-interactive-form-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=example.com"], { stdio: "ignore" });
  const server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const driver = new InteractiveBrowserDriver({
    proxyFactory: (allowed) => EgressProxy.start(allowed, {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      dial: () => connect(address.port, "127.0.0.1"),
    }),
    assertHost: async () => undefined,
    ignoreHTTPSErrors: true,
  });
  return { driver, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

test("approved fill locks network and exact approved form sends one POST", async () => {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const local = await fixture((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });
      response.writeHead(200, { "content-type": "text/html" });
      response.end(request.url === "/inquiries" ? "<title>Done</title><p>Saved</p>" : `
        <title>Form</title><form action="/inquiries" method="post">
          <label>Message <input name="message" type="text"></label>
          <label>Category <select name="category"><option value="general">General</option><option value="technical">Technical</option></select></label>
          <input name="csrf" type="hidden" value="CSRF_TEST_ONLY">
          <button type="submit">Send inquiry</button>
        </form>
        <script>document.querySelector('input[name=message]').addEventListener('input', () => fetch('/leak?value=' + encodeURIComponent(document.querySelector('input[name=message]').value)))</script>`);
    });
  });
  try {
    const browser = await local.driver.open({ url: start, mode: "public", origins, valueKeys: ["message_value", "category_value"] });
    try {
      const initial = await browser.snapshot();
      const fill = initial.candidates.find(({ kind }) => kind === "fill");
      assert.ok(fill);
      const filled = await browser.execute(fill, "Exact message");
      assert.equal(filled.status, "acted");
      const select = filled.snapshot.candidates.find(({ kind, valueKey }) => kind === "select" && valueKey === "category_value");
      assert.ok(select);
      const selected = await browser.execute(select, "technical");
      assert.equal(selected.status, "acted");
      const submit = selected.snapshot.candidates.find(({ kind }) => kind === "submit");
      assert.ok(submit);
      assert.deepEqual(submit.form?.fields.map(({ name, value }) => [name, value]), [
        ["message", "Exact message"], ["category", "technical"], ["csrf", "CSRF_TEST_ONLY"],
      ]);
      const result = await browser.execute(submit);
      assert.equal(result.status, "submitted");
      assert.deepEqual(requests.filter(({ url }) => url.startsWith("/leak")), []);
      assert.deepEqual(requests.filter(({ method }) => method === "POST"), [
        { method: "POST", url: "/inquiries", body: "message=Exact+message&category=technical&csrf=CSRF_TEST_ONLY" },
      ]);
    } finally { await browser.close(); }
  } finally { await local.close(); }
});

test("redirect after approved POST is outcome_unknown and never retried", async () => {
  let posts = 0;
  const local = await fixture((request, response) => {
    if (request.method === "POST") {
      posts += 1;
      response.writeHead(302, { location: "/done" });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<title>Form</title><form action="/inquiries" method="post"><button type="submit">Send</button></form>');
    }
  });
  try {
    const browser = await local.driver.open({ url: start, mode: "public", origins, valueKeys: [] });
    try {
      const submit = (await browser.snapshot()).candidates.find(({ kind }) => kind === "submit");
      assert.ok(submit);
      assert.equal((await browser.execute(submit)).status, "outcome_unknown");
      assert.equal(posts, 1);
    } finally { await browser.close(); }
  } finally { await local.close(); }
});
