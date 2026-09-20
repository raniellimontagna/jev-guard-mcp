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
const BROWSER_ENV_KEYS = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] as const;

export function browserEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of BROWSER_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

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
      let ancestorsVisible = true;
      let element: HTMLElement | null = anchor;
      while (element) {
        const style = getComputedStyle(element);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity) <= 0
        ) {
          ancestorsVisible = false;
          break;
        }
        element = element.parentElement;
      }
      const intersectsViewport =
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      const visible =
        ancestorsVisible &&
        intersectsViewport &&
        rect.width > 0 &&
        rect.height > 0;
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

export interface NetworkPolicyController {
  expectDocument(rawUrl: string): void;
}

function networkDocumentUrl(rawUrl: string): string {
  const url = validateStartUrl(rawUrl);
  url.hash = "";
  return url.href;
}

export async function installNetworkPolicy(
  context: BrowserContext,
  page: Page,
  allowedOrigin: string,
  assertHost: (hostname: string) => Promise<void> = assertPublicHostname,
): Promise<NetworkPolicyController> {
  let expectedDocumentUrl: string | undefined;
  await context.route("**/*", async (route: Route) => {
    try {
      const request = route.request();
      const rawUrl = request.url();
      const documentRequest = request.isNavigationRequest() || request.resourceType() === "document";
      if (documentRequest && request.frame() !== page.mainFrame()) {
        await route.abort("blockedbyclient");
        return;
      }
      if (rawUrl.startsWith("data:") || rawUrl.startsWith("blob:") || rawUrl === "about:blank") {
        await route.continue();
        return;
      }

      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || url.username || url.password) {
        await route.abort("blockedbyclient");
        return;
      }
      if (documentRequest) {
        url.hash = "";
        if (url.origin !== allowedOrigin || !expectedDocumentUrl || url.href !== expectedDocumentUrl) {
          await route.abort("blockedbyclient");
          return;
        }
      }

      await assertHost(url.hostname);
      // Browser-followed redirects bypass routing. Fetch exactly one response and
      // never expose a redirect to the browser, including for public subresources.
      const response = await route.fetch({ maxRedirects: 0, timeout: NAVIGATION_TIMEOUT_MS });
      try {
        if (response.status() >= 300 && response.status() < 400) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.fulfill({ response });
      } finally {
        await response.dispose();
      }
    } catch {
      await route.abort("blockedbyclient").catch(() => undefined);
    }
  });
  return {
    expectDocument(rawUrl) {
      const url = validateStartUrl(rawUrl);
      if (url.origin !== allowedOrigin) throw new Error("Cross-origin navigation is blocked");
      expectedDocumentUrl = networkDocumentUrl(url.href);
    },
  };
}

class PlaywrightSession implements BrowserSession {
  #closed = false;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly allowedOrigin: string,
    private readonly networkPolicy: NetworkPolicyController,
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
    this.networkPolicy.expectDocument(url.href);
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

    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      env: browserEnvironment(),
    });
    try {
      const context = await browser.newContext(ISOLATED_CONTEXT_OPTIONS);
      const page = await context.newPage();
      page.on("popup", (popup) => void popup.close());
      page.on("download", (download) => void download.cancel());
      await blockWebSockets(context);
      const networkPolicy = await installNetworkPolicy(context, page, url.origin);
      networkPolicy.expectDocument(url.href);
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
      const finalUrl = validateStartUrl(page.url());
      if (finalUrl.origin !== url.origin) throw new Error("Initial navigation left the allowed origin");
      return new PlaywrightSession(browser, context, page, url.origin, networkPolicy);
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }
}
