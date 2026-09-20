import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Route,
} from "playwright";

import type { PageSnapshot, RawPageSnapshot } from "../contracts.js";
import { assertPublicHostname, candidateUrl, validateStartUrl } from "../security/url-policy.js";
import type { BrowserDriver, BrowserSession } from "./browser-driver.js";
import { buildSnapshot } from "./snapshot.js";

const NAVIGATION_TIMEOUT_MS = 15_000;

export const ISOLATED_CONTEXT_OPTIONS = {
  acceptDownloads: false,
  javaScriptEnabled: false,
  serviceWorkers: "block",
} satisfies BrowserContextOptions;

export async function blockWebSockets(context: BrowserContext): Promise<void> {
  await context.routeWebSocket(/.*/, async (socket) => {
    await socket.close({ code: 1008, reason: "WebSockets are blocked by Jev Guard" });
  });
}

export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  const raw = await page.evaluate<RawPageSnapshot>(() => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((anchor) => {
      const rect = anchor.getBoundingClientRect();
      const style = getComputedStyle(anchor);
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0";
      return {
        href: anchor.href,
        label: anchor.innerText || anchor.getAttribute("aria-label") || anchor.title || "",
        visible,
        download: anchor.hasAttribute("download"),
      };
    });

    return {
      url: location.href,
      title: document.title,
      text: document.body?.innerText ?? "",
      links,
    };
  });
  return buildSnapshot(raw);
}

export async function installNetworkPolicy(
  context: BrowserContext,
  page: Page,
  allowedOrigin: string,
  assertHost: (hostname: string) => Promise<void> = assertPublicHostname,
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    try {
      const request = route.request();
      const rawUrl = request.url();
      if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:") || rawUrl === "about:blank") {
        await route.continue();
        return;
      }

      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.username || url.password) {
        await route.abort("blockedbyclient");
        return;
      }
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && url.origin !== allowedOrigin) {
        await route.abort("blockedbyclient");
        return;
      }

      await assertHost(url.hostname);
      await route.continue();
    } catch {
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });
}

class PlaywrightSession implements BrowserSession {
  #closed = false;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly allowedOrigin: string,
  ) {}

  async snapshot(): Promise<PageSnapshot> {
    if (this.#closed) throw new Error("Browser session is closed");
    return snapshotPage(this.page);
  }

  async navigate(rawUrl: string): Promise<PageSnapshot> {
    if (this.#closed) throw new Error("Browser session is closed");
    const url = validateStartUrl(rawUrl);
    if (url.origin !== this.allowedOrigin) throw new Error("Cross-origin navigation is blocked");
    const current = validateStartUrl(this.page.url());
    const approved = candidateUrl(current, url.href, false);
    if (!approved || approved.href !== url.href) throw new Error("Navigation URL is outside the approved policy");
    await assertPublicHostname(url.hostname);
    await this.page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    const finalUrl = validateStartUrl(this.page.url());
    if (finalUrl.href !== url.href) throw new Error("Navigation left the exact approved destination");
    return snapshotPage(this.page);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}

export class PlaywrightBrowserDriver implements BrowserDriver {
  async open(rawUrl: string): Promise<BrowserSession> {
    const url = validateStartUrl(rawUrl);
    await assertPublicHostname(url.hostname);

    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const context = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
    const page = await context.newPage();
    page.on("popup", (popup) => void popup.close());
    page.on("download", (download) => void download.cancel());

    try {
      await blockWebSockets(context);
      await installNetworkPolicy(context, page, url.origin);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      const finalUrl = validateStartUrl(page.url());
      if (finalUrl.origin !== url.origin) throw new Error("Initial navigation left the allowed origin");
      return new PlaywrightSession(browser, context, page, url.origin);
    } catch (error) {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw error;
    }
  }
}
