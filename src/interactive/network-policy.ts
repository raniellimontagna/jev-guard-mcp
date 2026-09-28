import { validateStartUrl } from "../security/url-policy.js";
import { assertPublicHostname } from "../security/url-policy.js";
import type { BrowserContext, Page, Route } from "playwright";

export interface InteractiveOrigins {
  siteOrigin: string;
  authOrigins: string[];
  resourceOrigins: string[];
}

export interface NetworkRequest {
  url: string;
  method: string;
  resourceType: string;
  isMainFrame: boolean;
}

type Phase = "opening" | "manual" | "supervised" | "locked" | "submission";

function exactOrigin(raw: string): string {
  const url = validateStartUrl(raw);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Allowed origin must be exact");
  return url.origin;
}

function exactUrl(raw: string): URL {
  const url = validateStartUrl(raw);
  url.hash = "";
  return url;
}

export class InteractiveNetworkPolicy {
  readonly siteOrigin: string;
  readonly authOrigins: ReadonlySet<string>;
  readonly resourceOrigins: ReadonlySet<string>;
  #phase: Phase;
  #expectedDocument: string | undefined;
  #approvedSubmission: { method: "POST"; url: string } | undefined;
  #submissionAttempted = false;
  #submissionStatus: number | undefined;

  constructor(origins: InteractiveOrigins, mode: "public" | "auth", startUrl: string) {
    this.siteOrigin = exactOrigin(origins.siteOrigin);
    this.authOrigins = new Set(origins.authOrigins.map(exactOrigin));
    this.resourceOrigins = new Set(origins.resourceOrigins.map(exactOrigin));
    const start = exactUrl(startUrl);
    if (start.origin !== this.siteOrigin) throw new Error("Start URL must use the site origin");
    this.#phase = mode === "auth" ? "manual" : "opening";
    if (mode === "public") this.#expectedDocument = start.href;
  }

  allow(request: NetworkRequest): boolean {
    let url: URL;
    try { url = exactUrl(request.url); }
    catch { return false; }
    const method = request.method.toUpperCase();
    const isDocument = request.resourceType === "document";
    if (isDocument && !request.isMainFrame) return false;

    if (this.#phase === "submission") {
      const approved = this.#approvedSubmission;
      if (!approved || method !== approved.method || url.href !== approved.url || url.origin !== this.siteOrigin) return false;
      this.#approvedSubmission = undefined;
      this.#submissionAttempted = true;
      this.#submissionStatus = undefined;
      this.#phase = "locked";
      return true;
    }
    if (this.#phase === "locked") return false;

    if (this.#phase === "manual") {
      if (this.resourceOrigins.has(url.origin)) return !isDocument && (method === "GET" || method === "HEAD");
      return (url.origin === this.siteOrigin || this.authOrigins.has(url.origin))
        && (method === "GET" || method === "HEAD" || method === "POST");
    }

    if (method !== "GET" && method !== "HEAD") return false;
    if (isDocument) {
      if (url.origin !== this.siteOrigin || url.href !== this.#expectedDocument) return false;
      this.#expectedDocument = undefined;
      return true;
    }
    return url.origin === this.siteOrigin || this.resourceOrigins.has(url.origin);
  }

  allowRedirect(sourceRaw: string, location: string): boolean {
    if (this.#phase !== "manual") return false;
    try {
      const source = exactUrl(sourceRaw);
      const target = exactUrl(new URL(location, source).href);
      return (source.origin === this.siteOrigin || this.authOrigins.has(source.origin))
        && (target.origin === this.siteOrigin || this.authOrigins.has(target.origin));
    } catch { return false; }
  }

  enterSupervised(): void {
    if (this.#phase !== "opening" && this.#phase !== "manual") throw new Error("Session cannot enter supervised mode");
    this.#phase = "supervised";
    this.#expectedDocument = undefined;
  }

  approveDocument(rawUrl: string): void {
    if (this.#phase !== "supervised") throw new Error("Navigation cannot be approved in this phase");
    const url = exactUrl(rawUrl);
    if (url.origin !== this.siteOrigin) throw new Error("Navigation must stay on site origin");
    this.#expectedDocument = url.href;
  }

  lockAfterValue(): void {
    if (this.#phase !== "supervised" && this.#phase !== "locked") throw new Error("Input cannot be locked in this phase");
    this.#phase = "locked";
    this.#expectedDocument = undefined;
  }

  approveSubmission(input: { method: string; url: string }): void {
    if (this.#phase !== "supervised" && this.#phase !== "locked") throw new Error("Submission cannot be approved in this phase");
    if (input.method.toUpperCase() !== "POST") throw new Error("Only POST submissions are supported");
    const url = exactUrl(input.url);
    if (url.origin !== this.siteOrigin) throw new Error("Submission must stay on site origin");
    this.#approvedSubmission = { method: "POST", url: url.href };
    this.#submissionAttempted = false;
    this.#submissionStatus = undefined;
    this.#phase = "submission";
  }

  recordSubmissionResponse(status: number): void {
    if (this.#submissionAttempted) this.#submissionStatus = status;
  }

  submissionResult(): "not_attempted" | "submitted" | "outcome_unknown" {
    if (!this.#submissionAttempted) return "not_attempted";
    if (this.#submissionStatus !== undefined && this.#submissionStatus >= 200 && this.#submissionStatus < 300) return "submitted";
    return "outcome_unknown";
  }
}

export async function installInteractiveNetworkPolicy(
  context: BrowserContext,
  page: Page,
  policy: InteractiveNetworkPolicy,
  assertHost: (hostname: string) => Promise<void> = assertPublicHostname,
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    try {
      const request = route.request();
      const url = exactUrl(request.url());
      const approved = policy.allow({
        url: url.href,
        method: request.method(),
        resourceType: request.resourceType(),
        isMainFrame: request.frame() === page.mainFrame(),
      });
      if (!approved) {
        await route.abort("blockedbyclient");
        return;
      }
      await assertHost(url.hostname);
      const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      try {
        const status = response.status();
        if (request.method().toUpperCase() === "POST") policy.recordSubmissionResponse(status);
        if (status >= 300 && status < 400 && !policy.allowRedirect(url.href, response.headers()["location"] ?? "")) {
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
}
