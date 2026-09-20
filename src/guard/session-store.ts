import { randomBytes } from "node:crypto";

import type { BrowserSession } from "../browser/browser-driver.js";
import type { LinkCandidate, PageSnapshot } from "../contracts.js";
import type { DecisionUsage } from "../decision/jev-client.js";

export interface PendingNavigation {
  browser: BrowserSession;
  snapshot: PageSnapshot;
  candidate: LinkCandidate;
  confidence: number;
  usage: DecisionUsage;
}

interface StoredNavigation extends PendingNavigation {
  token: string;
  expiresAt: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

interface SessionStoreOptions {
  maxSessions?: number;
  ttlMs?: number;
  now?: () => number;
  tokenFactory?: () => string;
}

export class SessionStore {
  readonly #entries = new Map<string, StoredNavigation>();
  readonly #maxSessions: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #tokenFactory: () => string;

  constructor(options: SessionStoreOptions = {}) {
    this.#maxSessions = options.maxSessions ?? 3;
    this.#ttlMs = options.ttlMs ?? 120_000;
    this.#now = options.now ?? Date.now;
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  async put(value: PendingNavigation): Promise<{ token: string; expiresAt: number }> {
    await this.#pruneExpired();
    if (this.#entries.size >= this.#maxSessions) {
      throw new Error("Too many pending Jev Guard previews");
    }

    let token = this.#tokenFactory();
    while (this.#entries.has(token)) token = this.#tokenFactory();
    const expiresAt = this.#now() + this.#ttlMs;
    const entry: StoredNavigation = { ...value, token, expiresAt };
    entry.expiryTimer = setTimeout(() => {
      void this.#expire(token).catch(() => undefined);
    }, this.#ttlMs);
    entry.expiryTimer.unref();
    this.#entries.set(token, entry);
    return { token, expiresAt };
  }

  async consume(token: string): Promise<StoredNavigation> {
    const entry = this.#entries.get(token);
    if (!entry) throw new Error("Preview token is invalid or already consumed");

    this.#entries.delete(token);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    if (entry.expiresAt <= this.#now()) {
      await entry.browser.close();
      throw new Error("Preview token expired");
    }
    return entry;
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    await Promise.all(entries.map(({ browser }) => browser.close()));
  }

  async #expire(token: string): Promise<void> {
    const entry = this.#entries.get(token);
    if (!entry) return;
    this.#entries.delete(token);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    await entry.browser.close();
  }

  async #pruneExpired(): Promise<void> {
    const now = this.#now();
    const expired = [...this.#entries.values()].filter(({ expiresAt }) => expiresAt <= now);
    for (const entry of expired) this.#entries.delete(entry.token);
    for (const entry of expired) if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    await Promise.all(expired.map(({ browser }) => browser.close()));
  }
}
