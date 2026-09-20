import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";

import {
  blockWebSockets,
  browserEnvironment,
  installNetworkPolicy,
  ISOLATED_CONTEXT_OPTIONS,
  PlaywrightBrowserDriver,
  snapshotPage,
} from "../src/browser/playwright-driver.js";

test("closes a launched browser when context initialization fails", async (context) => {
  let closed = false;
  context.mock.method(chromium, "launch", async () => ({
    async newContext() { throw new Error("context initialization failed"); },
    async close() { closed = true; },
  }) as unknown as Browser);
  await assert.rejects(new PlaywrightBrowserDriver().open("https://1.1.1.1/"), /context initialization failed/);
  assert.equal(closed, true);
});

test("never follows actual HTTPS 301/302/303/307/308 subresource responses", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "jev-redirect-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const requests: string[] = [];
  const server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, (request, response) => {
    requests.push(request.url ?? "");
    if (request.url?.startsWith("/redirect/")) response.writeHead(Number(request.url.split("/")[2]), { location: "/delete?private=SYNTHETIC_SECRET" });
    else response.writeHead(200, { "content-type": "image/png" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext({ ...ISOLATED_CONTEXT_OPTIONS, ignoreHTTPSErrors: true });
  const page = await browserContext.newPage();
  await installNetworkPolicy(browserContext, page, "https://example.com", async () => undefined);
  for (const status of [301, 302, 303, 307, 308]) {
    await page.setContent(`<img src="https://127.0.0.1:${address.port}/redirect/${status}">`);
  }
  assert.deepEqual(requests, [301, 302, 303, 307, 308].map((status) => `/redirect/${status}`));
});

test("aborts risky cross-origin iframe documents before hostname checks or network", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
  const page = await browserContext.newPage();
  const checked: string[] = [];
  const failures: string[] = [];
  page.on("requestfailed", (request) => failures.push(request.url()));
  await installNetworkPolicy(browserContext, page, "https://example.com", async (host) => { checked.push(host); throw new Error("fixture network disabled"); });
  const target = "https://other.example/delete?private=SYNTHETIC_SECRET";
  await page.setContent(`<iframe src="${target}"></iframe>`);
  assert.deepEqual(checked, []);
  assert.deepEqual(failures, [target]);
});

test("passes only a minimal non-secret environment to Chrome", () => {
  assert.deepEqual(
    browserEnvironment({
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      TYPESAFE_API_KEY: "secret",
      OTHER_API_TOKEN: "also-secret",
    }),
    { HOME: "/tmp/home", PATH: "/usr/bin", LANG: "en_US.UTF-8" },
  );
});

test("disables page JavaScript in the isolated browser context", () => {
  assert.equal(ISOLATED_CONTEXT_OPTIONS.javaScriptEnabled, false);
  assert.equal(ISOLATED_CONTEXT_OPTIONS.acceptDownloads, false);
  assert.equal(ISOLATED_CONTEXT_OPTIONS.serviceWorkers, "block");
});

test("blocks page WebSockets without connecting to the remote server", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  await blockWebSockets(browserContext);
  const page = await browserContext.newPage();

  const outcome = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket("wss://example.com/private");
        socket.addEventListener("open", () => resolve("opened"));
        socket.addEventListener("error", () => resolve("blocked"));
        socket.addEventListener("close", () => resolve("blocked"));
        setTimeout(() => resolve("timeout"), 2_000);
      }),
  );

  assert.equal(outcome, "blocked");
});

test("rechecks the hostname for every request and blocks rejected hosts", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  let checks = 0;
  await installNetworkPolicy(browserContext, page, "https://example.com", async (hostname) => {
    assert.equal(hostname, "repeat.example");
    checks += 1;
    throw new Error("blocked test host");
  });

  await page.setContent(
    '<img src="https://repeat.example/one"><img src="https://repeat.example/two">',
  );
  assert.equal(checks, 2);
});

test("blocks cross-origin main-frame navigation before a network connection", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  await installNetworkPolicy(browserContext, page, "https://example.com", async () => undefined);

  await assert.rejects(() => page.goto("https://other.example/path"), /ERR_(?:FAILED|BLOCKED_BY_CLIENT)/);
});

test("blocks a same-origin main-frame URL that was not exactly approved", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const browserContext = await browser.newContext();
  const page = await browserContext.newPage();
  const policy = await installNetworkPolicy(
    browserContext,
    page,
    "https://example.com",
    async () => undefined,
  );
  policy.expectDocument("https://example.com/approved");

  await assert.rejects(
    () => page.goto("https://example.com/logout?token=secret"),
    /ERR_(?:FAILED|BLOCKED_BY_CLIENT)/,
  );
});

test("extracts only visible safe anchors without form values or raw HTML", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://example.com/start", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <title>Fixture</title>
        <main>
          <p>Public body text</p>
          <a href="/docs">Docs</a>
          <a href="/search?q=secret">Search</a>
          <a href="https://other.example/page">Other</a>
          <a href="/logout">Logout</a>
          <a href="/file.zip" download>Download</a>
          <a href="/hidden" style="display:none">Hidden</a>
          <div style="opacity:0"><a href="/ancestor-hidden">Ancestor hidden</a></div>
          <a href="/offscreen" style="position:absolute;top:5000px">Offscreen</a>
          <input name="account" value="PRIVATE_INPUT_VALUE">
          <script>window.rawSecret = "RAW_HTML_SECRET";</script>
        </main>`,
    });
  });
  await page.goto("https://example.com/start");

  const snapshot = await snapshotPage(page);
  const serialized = JSON.stringify(snapshot);

  assert.deepEqual(snapshot.candidates.map(({ label }) => label), ["Docs"]);
  assert.match(snapshot.text, /Public body text/);
  assert.doesNotMatch(serialized, /PRIVATE_INPUT_VALUE|RAW_HTML_SECRET|<main>/);
});

test("treats zero-area and transparent anchors as invisible", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://example.com/start", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<a href="/zero" style="width:0;height:0;display:block;overflow:hidden">Zero</a>
        <a href="/transparent" style="opacity:0">Transparent</a>`,
    });
  });
  await page.goto("https://example.com/start");

  assert.equal((await snapshotPage(page)).candidates.length, 0);
});
