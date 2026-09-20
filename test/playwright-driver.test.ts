import assert from "node:assert/strict";
import test from "node:test";

import { chromium } from "playwright";

import { snapshotPage } from "../src/browser/playwright-driver.js";

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
