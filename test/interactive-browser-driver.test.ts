import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";

import { InteractiveBrowserDriver, observeInteractivePage } from "../src/interactive/browser-driver.js";
import { EgressProxy } from "../src/interactive/egress-proxy.js";

test("observes dynamic controls and private form evidence without exposing hidden inputs as actions", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
    <title>Fixture</title>
    <main>
      <a href="https://example.com/next">Next page</a>
      <button id="expand" aria-expanded="false" onclick="document.querySelector('#details').hidden=false;this.setAttribute('aria-expanded','true')">Details</button>
      <p id="details" hidden>Expanded content</p>
      <form action="https://example.com/send" method="post">
        <label>Email <input name="email" type="email" value="private@example.com"></label>
        <input name="csrf" type="hidden" value="PRIVATE_CSRF">
        <button type="submit">Send</button>
      </form>
      <button onclick="fetch('/unknown', {method:'POST'})">Unknown action</button>
    </main>`);

  const raw = await observeInteractivePage(page);
  assert.deepEqual(raw.elements.map(({ kind, label }) => [kind, label]), [
    ["link", "Next page"], ["button", "Details"], ["field", "Email"], ["submit", "Send"], ["button", "Unknown action"],
  ]);
  assert.equal(raw.elements[1]?.buttonEffect, "disclosure");
  assert.equal(raw.elements[4]?.buttonEffect, undefined);
  assert.equal(raw.elements[3]?.form?.fields.find(({ name }) => name === "csrf")?.value, "PRIVATE_CSRF");
  assert.equal(raw.elements[3]?.form?.fields.find(({ name }) => name === "csrf")?.hidden, true);
});

test("opens an isolated public page through the checked proxy and follows one approved link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-interactive-fixture-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=example.com"], { stdio: "ignore" });
  const requests: string[] = [];
  const server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, (request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/next"
      ? '<title>Next</title><main><p>Reached the next page</p></main>'
      : '<title>Start</title><main><button aria-expanded="false" onclick="this.setAttribute(\'aria-expanded\',\'true\');document.querySelector(\'#details\').hidden=false">Details</button><p id="details" hidden>Expanded content</p><a href="/next">Read next</a><div role="progressbar">Loading</div><div style="height:1800px"></div></main>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const driver = new InteractiveBrowserDriver({
    proxyFactory: (origins) => EgressProxy.start(origins, {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      dial: () => connect(address.port, "127.0.0.1"),
    }),
    assertHost: async () => undefined,
    ignoreHTTPSErrors: true,
  });
  try {
    const session = await driver.open({
      url: "https://example.com/start",
      mode: "public",
      origins: { siteOrigin: "https://example.com", authOrigins: [], resourceOrigins: [] },
      valueKeys: [],
    });
    try {
      const first = await session.snapshot();
      const disclosure = first.candidates.find(({ kind }) => kind === "toggle");
      assert.ok(disclosure);
      const expanded = await session.execute(disclosure);
      assert.match(expanded.snapshot.modelText, /Expanded content/);
      const scrollDown = expanded.snapshot.candidates.find(({ kind, direction }) => kind === "scroll" && direction === "down");
      assert.ok(scrollDown);
      const scrolled = await session.execute(scrollDown);
      const scrollUp = scrolled.snapshot.candidates.find(({ kind, direction }) => kind === "scroll" && direction === "up");
      assert.ok(scrollUp);
      await session.execute(scrollUp);
      const wait = (await session.snapshot()).candidates.find(({ kind }) => kind === "wait");
      assert.ok(wait);
      assert.equal((await session.execute(wait)).status, "acted");
      const link = first.candidates.find(({ kind }) => kind === "navigate");
      assert.ok(link);
      assert.equal(link.destination, "https://example.com/next");
      const result = await session.execute(link);
      assert.equal(result.status, "acted");
      assert.equal(result.snapshot.sourceUrl, "https://example.com/next");
      assert.deepEqual(requests, ["/start", "/next"]);
    } finally {
      await session.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("manual login stays outside Jev observation until the user reaches the site", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-interactive-auth-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-days", "1", "-subj", "/CN=example.com"], { stdio: "ignore" });
  const requests: string[] = [];
  const server = createServer({ key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) }, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/session" && request.method === "POST") {
      response.writeHead(302, { location: "/home" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(request.url === "/home"
      ? '<title>Home</title><main><p>Signed in</p></main>'
      : '<title>Login</title><form action="/session" method="post"><input type="password" name="password"><button type="submit">Sign in</button></form>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let capturedBrowser: Browser | undefined;
  const realLaunch = chromium.launch.bind(chromium);
  const driver = new InteractiveBrowserDriver({
    proxyFactory: (origins) => EgressProxy.start(origins, {
      lookup: async () => [{ address: "1.1.1.1", family: 4 }],
      dial: () => connect(address.port, "127.0.0.1"),
    }),
    assertHost: async () => undefined,
    ignoreHTTPSErrors: true,
    headlessAuth: true,
    launch: async (options) => { capturedBrowser = await realLaunch(options); return capturedBrowser; },
  });
  try {
    const session = await driver.open({
      url: "https://example.com/login", mode: "auth",
      origins: { siteOrigin: "https://example.com", authOrigins: [], resourceOrigins: [] }, valueKeys: [],
    });
    try {
      assert.equal(await session.finishManualLogin(), false);
      await assert.rejects(() => session.snapshot(), /login/i);
      assert.ok(capturedBrowser);
      const page = capturedBrowser.contexts()[0]?.pages()[0];
      assert.ok(page);
      await page.locator('input[name="password"]').fill("SYNTHETIC_LOGIN_ONLY");
      await page.locator('button[type="submit"]').click();
      await page.waitForURL("https://example.com/home");
      assert.equal(await session.finishManualLogin(), true);
      assert.equal((await session.snapshot()).title, "Home");
      assert.deepEqual(requests.filter((item) => !item.includes("favicon")), ["GET /login", "POST /session", "GET /home"]);
    } finally {
      await session.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
