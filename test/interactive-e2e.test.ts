import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import type { RequestListener } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";

import type { JevTransport } from "../src/decision/typesafe-client.js";
import { InteractiveBrowserDriver } from "../src/interactive/browser-driver.js";
import { InteractiveJevClient } from "../src/interactive/decision.js";
import { EgressProxy } from "../src/interactive/egress-proxy.js";
import { InteractiveSessionService } from "../src/interactive/session-service.js";

const origins = { siteOrigin: "https://example.com", authOrigins: [], resourceOrigins: [] };

async function syntheticSite(handler: RequestListener, capture?: (browser: Browser) => void) {
  const directory = await mkdtemp(join(tmpdir(), "jev-interactive-e2e-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=example.com"], { stdio: "ignore" });
  const server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const launch = chromium.launch.bind(chromium);
  const driver = new InteractiveBrowserDriver({
    proxyFactory: (allowed) => EgressProxy.start(allowed, {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      dial: () => connect(address.port, "127.0.0.1"),
    }),
    assertHost: async () => undefined,
    ignoreHTTPSErrors: true,
    headlessAuth: true,
    launch: async (options) => {
      const browser = await launch(options);
      capture?.(browser);
      return browser;
    },
  });
  return { driver, server, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

function selected(choice: string, ids: string[]) {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 10, output_tokens: 2 },
    answers: { next: {
      type: "choice" as const, choice, confidence: 1,
      probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 1 : 0])),
    } },
  };
}

test("public reading completes only after two inert previews and two single-use approvals", async () => {
  const requests: string[] = [];
  const site = await syntheticSite((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/next"
      ? '<title>Next</title><main>Target article <a href="/next">Read again</a></main>'
      : '<title>Start</title><main><a href="/next">Read article</a></main>');
  });
  const modelRequests: string[] = [];
  const transport: JevTransport = async (request) => {
    modelRequests.push(JSON.stringify(request));
    const ids = ["done", "blocked", ...request.state.actions.map(({ id }) => id)];
    return selected(request.state.page.url.endsWith("/next") ? "done" : request.state.actions[0]!.id, ids);
  };
  const service = new InteractiveSessionService(site.driver, new InteractiveJevClient(transport));
  try {
    const opened = await service.open({ url: "https://example.com/start", goal: "Read target article", mode: "public", origins, values: {},
      expectedResult: { kind: "url", value: "https://example.com/next" } });
    const first = await service.preview(opened.sessionId);
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;
    assert.deepEqual(requests.filter((item) => !item.includes("favicon")), ["GET /start"]);
    const acted = await service.execute(first.token);
    assert.equal(acted.status, "acted");
    assert.equal(acted.page.url, "https://example.com/next");
    await assert.rejects(() => service.execute(first.token), /consumed/i);
    assert.equal((await service.preview(opened.sessionId)).status, "verified_done");
    assert.deepEqual(requests.filter((item) => !item.includes("favicon")), ["GET /start", "GET /next"]);
    assert.equal(modelRequests.length, 2);
  } finally { await service.close(); await site.close(); }
});

test("assembled browser closes popups, cancels downloads and blocks WebSockets", async () => {
  let browser: Browser | undefined;
  let upgrades = 0;
  const site = await syntheticSite((request, response) => {
    if (request.url === "/file") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=test.bin" });
      response.end("synthetic file");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<title>Boundary</title><button id="popup" onclick="window.open(\'/popup\')">Popup</button><a id="download" href="/file" download>Download</a><button id="ws" onclick="window.wsConnected=false;const socket=new WebSocket(\'wss://example.com/socket\');socket.onopen=()=>window.wsConnected=true">WebSocket</button>');
  }, (value) => { browser = value; });
  site.server.on("upgrade", () => { upgrades += 1; });
  try {
    const session = await site.driver.open({ url: "https://example.com/start", mode: "public", origins, valueKeys: [] });
    try {
      assert.ok(browser);
      const context = browser.contexts()[0];
      const page = context?.pages()[0];
      assert.ok(context && page);
      const popup = page.waitForEvent("popup");
      await page.locator("#popup").click();
      const popupPage = await popup;
      if (!popupPage.isClosed()) await popupPage.waitForEvent("close", { timeout: 2_000 });
      assert.equal(popupPage.isClosed(), true);
      assert.equal(context.pages().length, 1);
      const download = page.waitForEvent("download");
      await page.locator("#download").click();
      assert.match((await (await download).failure()) ?? "", /cancel|acceptDownloads: true/i);
      await page.locator("#ws").click();
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => (window as unknown as { wsConnected: boolean }).wsConnected), false);
      assert.equal(upgrades, 0);
    } finally { await session.close(); }
  } finally { await site.close(); }
});

test("manual login is private to Chrome, then each fill and POST has a separate approval", async () => {
  let browser: Browser | undefined;
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const site = await syntheticSite((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });
      if (request.url === "/session" && request.method === "POST") {
        response.writeHead(302, { location: "/form" }); response.end(); return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(request.url === "/login"
        ? '<title>Login</title><form action="/session" method="post"><input type="password" name="password"><button type="submit">Sign in</button></form>'
        : request.url === "/form"
          ? '<title>Inquiry</title><form action="/inquiries" method="post"><label>Message <input name="message" type="text"></label><input name="csrf" type="hidden" value="SYNTHETIC_CSRF"><button type="submit">Send inquiry</button></form>'
          : '<title>Done</title><main>Inquiry received</main>');
    });
  }, (value) => { browser = value; });
  const modelRequests: string[] = [];
  let choiceCount = 0;
  const transport: JevTransport = async (request) => {
    choiceCount += 1;
    const serialized = JSON.stringify(request);
    modelRequests.push(serialized);
    assert.doesNotMatch(serialized, /SYNTHETIC_LOGIN_ONLY|SYNTHETIC_CSRF|Exact private message/);
    const ids = ["done", "blocked", ...request.state.actions.map(({ id }) => id)];
    const action = request.state.actions.find((item) => choiceCount === 1 ? item.label === "Message" : item.label === "Send inquiry");
    assert.ok(action);
    return selected(action.id, ids);
  };
  const service = new InteractiveSessionService(site.driver, new InteractiveJevClient(transport));
  try {
    const opened = await service.open({ url: "https://example.com/login", goal: "Send inquiry", mode: "auth", origins,
      values: { message_value: "Exact private message" }, shareRedactedPageTextWithTypeSafe: true,
      expectedResult: { kind: "text", value: "Inquiry received" } });
    assert.equal(opened.status, "manual_login_pending");
    assert.equal((await service.preview(opened.sessionId)).status, "login_required");
    assert.equal(modelRequests.length, 0);
    assert.ok(browser);
    const page = browser.contexts()[0]?.pages()[0];
    assert.ok(page);
    await page.locator('input[name="password"]').fill("SYNTHETIC_LOGIN_ONLY");
    await page.locator('button[type="submit"]').click();
    await page.waitForURL("https://example.com/form");
    const fill = await service.preview(opened.sessionId);
    assert.equal(fill.status, "ready");
    if (fill.status !== "ready") return;
    assert.equal(fill.action.kind, "fill");
    assert.equal(fill.action.value, "Exact private message");
    assert.equal((await service.execute(fill.token)).status, "acted");
    const submit = await service.preview(opened.sessionId);
    assert.equal(submit.status, "ready");
    if (submit.status !== "ready") return;
    assert.equal(submit.action.kind, "submit");
    assert.deepEqual(submit.action.fields, [
      { name: "message", value: "Exact private message" }, { name: "csrf", value: "[HIDDEN]" },
    ]);
    assert.deepEqual(requests.filter(({ method }) => method === "POST").map(({ url }) => url), ["/session"]);
    const result = await service.execute(submit.token);
    assert.equal(result.status, "submitted");
    assert.equal(result.page.text, "Inquiry received");
    assert.deepEqual(requests.filter(({ method }) => method === "POST").map(({ url, body }) => ({ url, body })), [
      { url: "/session", body: "password=SYNTHETIC_LOGIN_ONLY" },
      { url: "/inquiries", body: "message=Exact+private+message&csrf=SYNTHETIC_CSRF" },
    ]);
    assert.equal(modelRequests.length, 2);
    await assert.rejects(() => service.preview(opened.sessionId), /closed/i);
  } finally { await service.close(); await site.close(); }
});
