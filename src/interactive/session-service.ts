import { randomBytes } from "node:crypto";

import type { DecisionUsage } from "../decision/jev-client.js";
import { JEV_MODEL } from "../decision/typesafe-client.js";
import type { InteractiveBrowserSession, InteractiveOpenOptions, BrowserExecutionResult } from "./browser-driver.js";
import type { ActionCandidate, InteractiveSnapshot } from "./contracts.js";
import type { InteractiveDecision, InteractiveDecisionInput } from "./decision.js";
import type { InteractiveOrigins } from "./network-policy.js";
import { safeValueKey } from "./snapshot.js";

export interface InteractiveOpenRequest {
  url: string;
  goal: string;
  mode: "public" | "auth";
  origins: InteractiveOrigins;
  values: Record<string, string>;
  shareRedactedPageTextWithTypeSafe?: boolean;
  expectedResult?: { kind: "url" | "text"; value: string };
}

interface PendingAction {
  token: string;
  expiresAt: number;
  snapshot: InteractiveSnapshot;
  candidate: ActionCandidate;
  confidence: number;
  usage: DecisionUsage;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveSession {
  id: string;
  browser: InteractiveBrowserSession;
  goal: string;
  values: Record<string, string>;
  expectedResult?: { kind: "url" | "text"; value: string };
  manualLoginPending: boolean;
  actions: number;
  modelCalls: number;
  busy: boolean;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  pending: PendingAction | undefined;
}

export type InteractivePreviewResult =
  | { status: "login_required" }
  | { status: "blocked" | "low_confidence" | "verified_done" | "done_unverified"; confidence: number; choice: string; usage: DecisionUsage }
  | {
      status: "ready";
      sessionId: string;
      token: string;
      expiresAt: string;
      sourceUrl: string;
      confidence: number;
      action: {
        id: string; kind: ActionCandidate["kind"]; label: string; destination: string;
        value?: string;
        method?: "POST";
        fields?: Array<{ name: string; value: string }>;
      };
      usage: DecisionUsage;
    };

export interface InteractiveExecuteResult {
  status: BrowserExecutionResult["status"];
  sessionId: string;
  action: { id: string; kind: ActionCandidate["kind"]; label: string; destination: string };
  page: { url: string; title: string; text: string };
  usage: DecisionUsage;
}

interface BrowserDriverLike {
  open(input: InteractiveOpenOptions): Promise<InteractiveBrowserSession>;
}

interface JevClientLike {
  choose(input: InteractiveDecisionInput, options?: { signal?: AbortSignal }): Promise<InteractiveDecision>;
}

interface ServiceOptions {
  now?: () => number;
  maxSessions?: number;
  sessionTtlMs?: number;
  tokenTtlMs?: number;
  sessionIdFactory?: () => string;
  tokenFactory?: () => string;
  maxActions?: number;
  maxModelCalls?: number;
}

function randomId(): string { return randomBytes(32).toString("base64url"); }

function actionSummary(candidate: ActionCandidate) {
  return { id: candidate.id, kind: candidate.kind, label: candidate.label, destination: candidate.destination };
}

function previewAction(candidate: ActionCandidate, values: Record<string, string>) {
  const summary = actionSummary(candidate);
  if (candidate.kind === "fill" || candidate.kind === "select") {
    if (!candidate.valueKey || !Object.hasOwn(values, candidate.valueKey)) throw new Error("Interactive value key is unavailable");
    const value = values[candidate.valueKey];
    if (value === undefined) throw new Error("Interactive value key is unavailable");
    return { ...summary, value };
  }
  if (candidate.kind === "submit") {
    if (!candidate.form) throw new Error("Interactive form evidence is unavailable");
    return {
      ...summary,
      method: "POST" as const,
      fields: candidate.form.fields.map(({ name, value, hidden }) => ({ name, value: hidden ? "[HIDDEN]" : value })),
    };
  }
  return summary;
}

function redactKnownValues(value: string, values: Record<string, string>): string {
  let result = value;
  for (const privateValue of Object.values(values).sort((a, b) => b.length - a.length)) {
    if (privateValue) result = result.split(privateValue).join("[REDACTED_VALUE]");
  }
  return result;
}

function modelSafeSnapshot(snapshot: InteractiveSnapshot, values: Record<string, string>): InteractiveSnapshot {
  return {
    ...snapshot,
    publicUrl: redactKnownValues(snapshot.publicUrl, values),
    title: redactKnownValues(snapshot.title, values),
    modelText: redactKnownValues(snapshot.modelText, values),
    modelActions: snapshot.modelActions.map((action) => ({
      ...action,
      label: redactKnownValues(action.label, values),
      destination: redactKnownValues(action.destination, values),
    })),
  };
}

function verified(snapshot: InteractiveSnapshot, expected?: { kind: "url" | "text"; value: string }): boolean {
  if (!expected || !expected.value) return false;
  return expected.kind === "url"
    ? snapshot.sourceUrl === expected.value
    : snapshot.modelText.includes(expected.value);
}

export class InteractiveSessionService {
  readonly #sessions = new Map<string, ActiveSession>();
  readonly #tokens = new Map<string, string>();
  readonly #openings = new Set<Promise<InteractiveBrowserSession>>();
  readonly #now: () => number;
  readonly #maxSessions: number;
  readonly #sessionTtlMs: number;
  readonly #tokenTtlMs: number;
  readonly #sessionIdFactory: () => string;
  readonly #tokenFactory: () => string;
  readonly #maxActions: number;
  readonly #maxModelCalls: number;
  #closed = false;
  #closing?: Promise<void>;

  constructor(
    private readonly driver: BrowserDriverLike,
    private readonly jev: JevClientLike,
    options: ServiceOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#maxSessions = options.maxSessions ?? 2;
    this.#sessionTtlMs = options.sessionTtlMs ?? 15 * 60_000;
    this.#tokenTtlMs = options.tokenTtlMs ?? 120_000;
    this.#sessionIdFactory = options.sessionIdFactory ?? randomId;
    this.#tokenFactory = options.tokenFactory ?? randomId;
    this.#maxActions = options.maxActions ?? 20;
    this.#maxModelCalls = options.maxModelCalls ?? 25;
  }

  async open(request: InteractiveOpenRequest): Promise<{ sessionId: string; status: "ready" | "manual_login_pending"; expiresAt: string }> {
    if (this.#closed) throw new Error("Interactive browser is closed");
    if (request.mode === "auth" && request.shareRedactedPageTextWithTypeSafe !== true) {
      throw new Error("Authenticated browsing requires page-text sharing opt-in");
    }
    const goal = request.goal.trim();
    if (!goal) throw new Error("Goal must not be empty");
    if (Object.keys(request.values).length > 20 || Object.entries(request.values).some(([key, value]) =>
      !safeValueKey(key) || typeof value !== "string" || value.length > 1_000 || value.includes("\0"))) {
      throw new Error("Interactive values are invalid or credential-like");
    }
    if (this.#sessions.size + this.#openings.size >= this.#maxSessions) throw new Error("Interactive session capacity exceeded");
    const opening = this.driver.open({
      url: request.url,
      mode: request.mode,
      origins: request.origins,
      valueKeys: Object.keys(request.values),
    });
    this.#openings.add(opening);
    let browser: InteractiveBrowserSession;
    try { browser = await opening; }
    finally { this.#openings.delete(opening); }
    if (this.#closed) {
      await browser.close();
      throw new Error("Interactive browser is closed");
    }
    let sessionId = this.#sessionIdFactory();
    while (this.#sessions.has(sessionId)) sessionId = this.#sessionIdFactory();
    const expiresAt = this.#now() + this.#sessionTtlMs;
    const timer = setTimeout(() => { void this.closeSession(sessionId).catch(() => undefined); }, this.#sessionTtlMs);
    timer.unref();
    const session: ActiveSession = {
      id: sessionId,
      browser,
      goal,
      values: { ...request.values },
      ...(request.expectedResult ? { expectedResult: request.expectedResult } : {}),
      manualLoginPending: request.mode === "auth",
      actions: 0,
      modelCalls: 0,
      busy: false,
      expiresAt,
      timer,
      pending: undefined,
    };
    this.#sessions.set(sessionId, session);
    return { sessionId, status: session.manualLoginPending ? "manual_login_pending" : "ready", expiresAt: new Date(expiresAt).toISOString() };
  }

  async preview(sessionId: string): Promise<InteractivePreviewResult> {
    const session = this.#requireSession(sessionId);
    if (session.busy) throw new Error("Interactive session is busy");
    if (session.pending) throw new Error("Interactive preview is already pending");
    session.busy = true;
    try {
      if (session.actions >= this.#maxActions || session.modelCalls >= this.#maxModelCalls) {
        await this.closeSession(sessionId);
        return {
          status: "blocked", confidence: 1, choice: "blocked",
          usage: { attempts: session.modelCalls, inputTokens: 0, outputTokens: 0, model: JEV_MODEL },
        };
      }
      if (session.manualLoginPending) {
        if (!await session.browser.finishManualLogin()) return { status: "login_required" };
        session.manualLoginPending = false;
      }
      this.#assertActive(session);
      const snapshot = await session.browser.snapshot();
      this.#assertActive(session);
      session.modelCalls += 1;
      const decision = await this.jev.choose({
        goal: redactKnownValues(session.goal, session.values),
        snapshot: modelSafeSnapshot(snapshot, session.values),
        valueKeys: Object.keys(session.values),
      });
      this.#assertActive(session);
      if (decision.status !== "ready") {
        const status = decision.status === "done"
          ? verified(snapshot, session.expectedResult) ? "verified_done" : "done_unverified"
          : decision.status;
        await this.closeSession(sessionId);
        return { status, confidence: decision.confidence, choice: decision.choice, usage: decision.usage };
      }
      const candidate = snapshot.candidates.find(({ id }) => id === decision.candidate.id);
      if (!candidate || candidate.fingerprint !== decision.candidate.fingerprint) {
        throw new Error("Jev selected an action outside the observed page");
      }
      const action = previewAction(candidate, session.values);
      let token = this.#tokenFactory();
      while (this.#tokens.has(token)) token = this.#tokenFactory();
      const expiresAt = this.#now() + this.#tokenTtlMs;
      const timer = setTimeout(() => { void this.closeSession(sessionId).catch(() => undefined); }, this.#tokenTtlMs);
      timer.unref();
      session.pending = { token, expiresAt, snapshot, candidate, confidence: decision.confidence, usage: decision.usage, timer };
      this.#tokens.set(token, sessionId);
      return {
        status: "ready",
        sessionId,
        token,
        expiresAt: new Date(expiresAt).toISOString(),
        sourceUrl: snapshot.publicUrl,
        confidence: decision.confidence,
        action,
        usage: decision.usage,
      };
    } catch (error) {
      if (this.#sessions.has(sessionId)) await this.closeSession(sessionId);
      throw error;
    } finally {
      session.busy = false;
    }
  }

  async execute(token: string): Promise<InteractiveExecuteResult> {
    const sessionId = this.#tokens.get(token);
    if (!sessionId) throw new Error("Interactive token is invalid or already consumed");
    const session = this.#requireSession(sessionId);
    if (session.busy) throw new Error("Interactive session is busy");
    this.#tokens.delete(token);
    const pending = session.pending;
    session.pending = undefined;
    if (!pending || pending.token !== token) throw new Error("Interactive token is invalid or already consumed");
    clearTimeout(pending.timer);
    session.busy = true;
    try {
      if (pending.expiresAt <= this.#now()) throw new Error("Interactive token expired");
      const fresh = await session.browser.snapshot();
      const action = fresh.candidates.find(({ id }) => id === pending.candidate.id);
      if (fresh.sourceUrl !== pending.snapshot.sourceUrl || !action || action.fingerprint !== pending.candidate.fingerprint) {
        throw new Error("Interactive preview is stale");
      }
      session.actions += 1;
      const value = action.valueKey ? session.values[action.valueKey] : undefined;
      const result = await session.browser.execute(action, value);
      this.#assertActive(session);
      const output: InteractiveExecuteResult = {
        status: result.status,
        sessionId,
        action: actionSummary(action),
        page: {
          url: redactKnownValues(result.snapshot.publicUrl, session.values),
          title: redactKnownValues(result.snapshot.title, session.values),
          text: redactKnownValues(result.snapshot.modelText, session.values),
        },
        usage: pending.usage,
      };
      if (action.kind === "submit") await this.closeSession(sessionId);
      return output;
    } catch (error) {
      if (this.#sessions.has(sessionId)) await this.closeSession(sessionId);
      throw error;
    } finally {
      session.busy = false;
    }
  }

  async cancel(token: string): Promise<{ status: "cancelled" }> {
    const sessionId = this.#tokens.get(token);
    if (!sessionId) throw new Error("Interactive token is invalid or already consumed");
    await this.closeSession(sessionId);
    return { status: "cancelled" };
  }

  async closeSession(sessionId: string): Promise<{ status: "closed" }> {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Interactive session is invalid or closed");
    this.#sessions.delete(sessionId);
    clearTimeout(session.timer);
    if (session.pending) {
      this.#tokens.delete(session.pending.token);
      clearTimeout(session.pending.timer);
      session.pending = undefined;
    }
    await session.browser.close();
    return { status: "closed" };
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = (async () => {
      await Promise.allSettled([...this.#openings]);
      await Promise.allSettled([...this.#sessions.keys()].map((id) => this.closeSession(id)));
    })();
    return this.#closing;
  }

  #requireSession(sessionId: string): ActiveSession {
    if (this.#closed) throw new Error("Interactive browser is closed");
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error("Interactive session is invalid or closed");
    if (session.expiresAt <= this.#now()) {
      void this.closeSession(sessionId).catch(() => undefined);
      throw new Error("Interactive session expired");
    }
    return session;
  }

  #assertActive(session: ActiveSession): void {
    if (this.#closed || !this.#sessions.has(session.id)) throw new Error("Interactive browser is closed");
    if (session.expiresAt <= this.#now()) throw new Error("Interactive session expired");
  }
}
