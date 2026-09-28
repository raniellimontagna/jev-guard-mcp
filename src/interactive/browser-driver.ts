import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright";

import { blockWebSockets, browserEnvironment } from "../browser/playwright-driver.js";
import { assertPublicHostname } from "../security/url-policy.js";
import { buildInteractiveSnapshot } from "./snapshot.js";
import { EgressProxy } from "./egress-proxy.js";
import { installInteractiveNetworkPolicy, InteractiveNetworkPolicy, type InteractiveOrigins } from "./network-policy.js";
import type { ActionCandidate, InteractiveSnapshot, RawInteractivePage } from "./contracts.js";

export const INTERACTIVE_SELECTOR = "a[href], button, input:not([type=hidden]), textarea, select";

export async function observeInteractivePage(page: Page): Promise<RawInteractivePage> {
  const raw = await page.evaluate((selector: string) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element, domIndex) => {
      const isAnchor = element instanceof HTMLAnchorElement;
      const isButton = element instanceof HTMLButtonElement;
      const isInput = element instanceof HTMLInputElement;
      const isSelect = element instanceof HTMLSelectElement;
      const isTextarea = element instanceof HTMLTextAreaElement;
      const control = isInput || isSelect || isTextarea ? element : undefined;
      const label = (
        element.getAttribute("aria-label")
        || control?.labels?.[0]?.innerText
        || element.innerText
        || element.getAttribute("placeholder")
        || element.getAttribute("title")
        || control?.name
        || ""
      ).trim();
      const enabled = !("disabled" in element && element.disabled) && element.getAttribute("aria-disabled") !== "true";
      const rect = element.getBoundingClientRect();
      let visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
      let ancestor: HTMLElement | null = element;
      while (visible && ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number.parseFloat(style.opacity) <= 0) visible = false;
        ancestor = ancestor.parentElement;
      }
      const common = { domIndex, label, visible, enabled };

      if (isAnchor) return { ...common, kind: "link" as const, href: element.href, download: element.hasAttribute("download") };
      const form = (isButton || isInput) ? element.form : null;
      if (form && ((isButton && element.type === "submit") || (isInput && element.type === "submit"))) {
        const fields = Array.from(new FormData(form).entries()).map(([name, value]) => {
          const matching = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[name]"))
            .find((field) => field.name === name);
          const type = matching instanceof HTMLInputElement ? matching.type : matching?.tagName.toLowerCase();
          return { name, value: typeof value === "string" ? value : value.name, hidden: type === "hidden", ...(type ? { type } : {}) };
        });
        return { ...common, kind: "submit" as const, form: {
          action: form.action,
          method: form.method,
          hasFileInput: form.querySelector('input[type="file"]') !== null,
          fields,
        } };
      }
      if (isButton || (isInput && element.type === "button")) {
        const buttonEffect = element.getAttribute("aria-expanded") !== null ? "disclosure" as const
          : element.getAttribute("role") === "tab" ? "tab" as const : undefined;
        return { ...common, kind: "button" as const, ...(buttonEffect ? { buttonEffect } : {}) };
      }
      if (isSelect) return { ...common, kind: "select" as const, name: element.name, fieldType: "select" };
      if (isInput || isTextarea) {
        return { ...common, kind: "field" as const, name: element.name, fieldType: isInput ? element.type : "textarea" };
      }
      return { ...common, kind: "button" as const };
    });

    return {
      url: location.href,
      title: document.title,
      text: document.body?.innerText ?? "",
      elements,
      viewport: {
        canScrollUp: scrollY > 0,
        canScrollDown: scrollY + innerHeight < document.documentElement.scrollHeight - 1,
      },
      canWait: document.querySelector('[aria-busy="true"], [role="progressbar"]') !== null,
    };
  }, INTERACTIVE_SELECTOR);
  return raw as RawInteractivePage;
}

export const INTERACTIVE_CONTEXT_OPTIONS = {
  acceptDownloads: false,
  javaScriptEnabled: true,
  serviceWorkers: "block",
} satisfies BrowserContextOptions;

export interface InteractiveOpenOptions {
  url: string;
  mode: "public" | "auth";
  origins: InteractiveOrigins;
  valueKeys: readonly string[];
}

export interface BrowserExecutionResult {
  status: "acted" | "submitted" | "outcome_unknown";
  snapshot: InteractiveSnapshot;
}

export interface InteractiveBrowserSession {
  snapshot(): Promise<InteractiveSnapshot>;
  finishManualLogin(): Promise<boolean>;
  execute(candidate: ActionCandidate, value?: string): Promise<BrowserExecutionResult>;
  close(): Promise<void>;
}

interface InteractiveDriverOptions {
  proxyFactory?: (origins: readonly string[]) => Promise<EgressProxy>;
  assertHost?: (hostname: string) => Promise<void>;
  ignoreHTTPSErrors?: boolean;
  headlessAuth?: boolean;
  launch?: (options: NonNullable<Parameters<typeof chromium.launch>[0]>) => Promise<Browser>;
}

class PlaywrightInteractiveSession implements InteractiveBrowserSession {
  #closed = false;
  #manualLoginPending: boolean;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly proxy: EgressProxy,
    private readonly policy: InteractiveNetworkPolicy,
    private readonly valueKeys: readonly string[],
    manualLoginPending: boolean,
  ) { this.#manualLoginPending = manualLoginPending; }

  async snapshot(): Promise<InteractiveSnapshot> {
    if (this.#closed) throw new Error("Interactive browser session is closed");
    if (this.#manualLoginPending) throw new Error("Manual login is still pending");
    return buildInteractiveSnapshot(await observeInteractivePage(this.page), { siteOrigin: this.policy.siteOrigin }, this.valueKeys);
  }

  async finishManualLogin(): Promise<boolean> {
    if (this.#closed) throw new Error("Interactive browser session is closed");
    if (!this.#manualLoginPending) return true;
    if (new URL(this.page.url()).origin !== this.policy.siteOrigin) return false;
    if (await this.page.locator('input[type="password"]:visible').count() > 0) return false;
    this.policy.enterSupervised();
    this.#manualLoginPending = false;
    return true;
  }

  async execute(candidate: ActionCandidate): Promise<BrowserExecutionResult> {
    if (this.#closed) throw new Error("Interactive browser session is closed");
    const fresh = await this.snapshot();
    const current = fresh.candidates.find(({ id }) => id === candidate.id);
    if (!current || current.fingerprint !== candidate.fingerprint) throw new Error("Interactive preview is stale");
    if (candidate.kind === "scroll") {
      if (!candidate.direction) throw new Error("Scroll direction is missing");
      await this.page.evaluate((direction) => scrollBy(0, direction === "down" ? 600 : -600), candidate.direction);
      return { status: "acted", snapshot: await this.snapshot() };
    }
    if (candidate.kind === "wait") {
      await this.page.waitForTimeout(250);
      return { status: "acted", snapshot: await this.snapshot() };
    }
    if (candidate.kind !== "navigate" && candidate.kind !== "toggle") throw new Error("Interactive action is not supported yet");
    if (candidate.kind === "navigate") this.policy.approveDocument(candidate.destination);
    await this.page.locator(INTERACTIVE_SELECTOR).nth(candidate.domIndex).click({ timeout: 10_000 });
    if (candidate.kind === "navigate") await this.page.waitForURL(candidate.destination, { timeout: 10_000 });
    return { status: "acted", snapshot: await this.snapshot() };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
    await this.proxy.close();
  }
}

export class InteractiveBrowserDriver {
  constructor(private readonly options: InteractiveDriverOptions = {}) {}

  async open(input: InteractiveOpenOptions): Promise<InteractiveBrowserSession> {
    const proxy = await (this.options.proxyFactory ?? EgressProxy.start)([
      input.origins.siteOrigin,
      ...input.origins.authOrigins,
      ...input.origins.resourceOrigins,
    ]);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    try {
      const policy = new InteractiveNetworkPolicy(input.origins, input.mode, input.url);
      browser = await (this.options.launch ?? chromium.launch.bind(chromium))({
        channel: "chrome",
        headless: input.mode === "public" || this.options.headlessAuth === true,
        env: browserEnvironment(),
        proxy: { server: proxy.url },
      });
      context = await browser.newContext({ ...INTERACTIVE_CONTEXT_OPTIONS, ignoreHTTPSErrors: this.options.ignoreHTTPSErrors === true });
      const page = await context.newPage();
      page.on("popup", (popup) => void popup.close());
      page.on("download", (download) => void download.cancel());
      await blockWebSockets(context);
      await installInteractiveNetworkPolicy(context, page, policy, this.options.assertHost ?? assertPublicHostname);
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      if (input.mode === "public") policy.enterSupervised();
      return new PlaywrightInteractiveSession(browser, context, page, proxy, policy, input.valueKeys, input.mode === "auth");
    } catch (error) {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await proxy.close().catch(() => undefined);
      throw error;
    }
  }
}
