import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";

import { InteractiveBrowserDriver } from "../src/interactive/browser-driver.js";
import { EgressProxy } from "../src/interactive/egress-proxy.js";
import { renderChessPage } from "./chess-demo-site.js";

const origin = "https://chess-demo.example";

export interface ChessDemoHarness {
  origin: typeof origin;
  driver: InteractiveBrowserDriver;
  requests: string[];
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

export async function startChessDemoHarness(): Promise<ChessDemoHarness> {
  const directory = await mkdtemp(join(tmpdir(), "jev-chess-demo-"));
  let browser: Browser | undefined;
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
      "-days", "1", "-subj", "/CN=chess-demo.example",
    ], { stdio: "ignore" });
    const requests: string[] = [];
    const server = createServer({
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    }, (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method !== "GET" || !request.url) {
        response.writeHead(405, { "content-type": "text/plain", "cache-control": "no-store" });
        response.end("Method not allowed");
        return;
      }
      const page = renderChessPage(request.url);
      response.writeHead(page.status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      });
      response.end(page.html);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Chess demo listener unavailable");
    const port = address.port;
    const driver = new InteractiveBrowserDriver({
      proxyFactory: (allowed) => EgressProxy.start(allowed, {
        lookup: async (hostname) => hostname === "chess-demo.example" ? [{ address: "1.1.1.1", family: 4 }] : [],
        dial: () => connect(port, "127.0.0.1"),
      }),
      assertHost: async (hostname) => {
        if (hostname !== "chess-demo.example") throw new Error("Chess demo only allows its fixture hostname");
      },
      ignoreHTTPSErrors: true,
      launch: async (options) => {
        browser = await chromium.launch(options);
        return browser;
      },
    });
    return {
      origin, driver, requests,
      async screenshot(path: string) {
        const page = browser?.contexts()[0]?.pages()[0];
        if (!page) throw new Error("Chess demo page unavailable");
        await page.screenshot({ path, fullPage: true });
      },
      async close() {
        await browser?.close().catch(() => undefined);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
