import type { BrowserDriver } from "../browser/browser-driver.js";
import type { LinkCandidate, PageSnapshot } from "../contracts.js";
import type { Decision, DecisionUsage, JevClient } from "../decision/jev-client.js";
import { validateStartUrl } from "../security/url-policy.js";
import { SessionStore } from "./session-store.js";

export interface PreviewRequest {
  url: string;
  goal: string;
}

export interface ReadyPreview {
  status: "ready";
  token: string;
  expiresAt: string;
  sourceUrl: string;
  confidence: number;
  action: { id: string; label: string; destination: string };
  usage: DecisionUsage;
}

export interface TerminalPreview {
  status: "done" | "blocked" | "low_confidence";
  confidence: number;
  choice: string;
  usage: DecisionUsage;
}

export type PreviewResult = ReadyPreview | TerminalPreview;

export interface ExecuteResult {
  status: "navigated";
  confidence: number;
  action: { id: string; label: string; destination: string };
  page: { url: string; title: string; text: string };
  usage: DecisionUsage;
}

function isSameCandidate(left: LinkCandidate, right: LinkCandidate): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.url === right.url &&
    left.publicUrl === right.publicUrl &&
    left.fingerprint === right.fingerprint
  );
}

function terminal(decision: Decision): TerminalPreview {
  if (decision.status === "ready") throw new Error("Expected a terminal Jev decision");
  return {
    status: decision.status,
    confidence: decision.confidence,
    choice: decision.choice,
    usage: decision.usage,
  };
}

function publicPage(snapshot: PageSnapshot): ExecuteResult["page"] {
  return { url: snapshot.publicUrl, title: snapshot.title, text: snapshot.text };
}

export class GuardService {
  constructor(
    private readonly driver: BrowserDriver,
    private readonly jev: JevClient,
    private readonly sessions = new SessionStore(),
  ) {}

  async preview(request: PreviewRequest, options: { signal?: AbortSignal } = {}): Promise<PreviewResult> {
    const url = validateStartUrl(request.url);
    const goal = request.goal.trim();
    if (!goal) throw new Error("Goal must not be empty");

    const browser = await this.driver.open(url.href);
    let retained = false;
    try {
      const snapshot = await browser.snapshot();
      const decision = await this.jev.choose(
        { goal, snapshot },
        options.signal ? { signal: options.signal } : undefined,
      );
      if (decision.status !== "ready") return terminal(decision);

      const observed = snapshot.candidates.find(({ id }) => id === decision.candidate.id);
      if (!observed || !isSameCandidate(observed, decision.candidate)) {
        throw new Error("Jev selected a candidate outside the observed snapshot");
      }

      const stored = await this.sessions.put({
        browser,
        snapshot,
        candidate: observed,
        confidence: decision.confidence,
        usage: decision.usage,
      });
      retained = true;
      return {
        status: "ready",
        token: stored.token,
        expiresAt: new Date(stored.expiresAt).toISOString(),
        sourceUrl: snapshot.publicUrl,
        confidence: decision.confidence,
        action: {
          id: observed.id,
          label: observed.label,
          destination: observed.publicUrl,
        },
        usage: decision.usage,
      };
    } finally {
      if (!retained) await browser.close();
    }
  }

  async execute(token: string): Promise<ExecuteResult> {
    const pending = await this.sessions.consume(token);
    try {
      const current = await pending.browser.snapshot();
      if (current.sourceUrl !== pending.snapshot.sourceUrl) {
        throw new Error("Preview is stale: source URL changed");
      }
      const candidate = current.candidates.find(({ id }) => id === pending.candidate.id);
      if (!candidate || !isSameCandidate(candidate, pending.candidate)) {
        throw new Error("Preview is stale: candidate changed or disappeared");
      }

      const result = await pending.browser.navigate(candidate.url);
      if (new URL(result.sourceUrl).origin !== new URL(candidate.url).origin) {
        throw new Error("Navigation postcondition failed: origin changed");
      }
      return {
        status: "navigated",
        confidence: pending.confidence,
        action: { id: candidate.id, label: candidate.label, destination: candidate.publicUrl },
        page: publicPage(result),
        usage: pending.usage,
      };
    } finally {
      await pending.browser.close();
    }
  }

  async cancel(token: string): Promise<{ status: "cancelled" }> {
    const pending = await this.sessions.consume(token);
    await pending.browser.close();
    return { status: "cancelled" };
  }

  async close(): Promise<void> {
    await this.sessions.closeAll();
  }
}
