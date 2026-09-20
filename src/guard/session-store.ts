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

export interface SessionReservation {
  attach(browser: BrowserSession): Promise<BrowserSession>;
  release(): Promise<void>;
}

export class SessionStore {
  readonly #entries = new Map<string, StoredNavigation>();
  readonly #reservations = new Set<SessionReservation>();
  readonly #maxSessions: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #tokenFactory: () => string;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: SessionStoreOptions = {}) {
    this.#maxSessions = options.maxSessions ?? 3;
    this.#ttlMs = options.ttlMs ?? 120_000;
    this.#now = options.now ?? Date.now;
    this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
  }

  async reserve(): Promise<SessionReservation> {
    await this.#pruneExpired();
    if (this.#closed) throw new Error("Session store is closed");
    if (this.#reservations.size >= this.#maxSessions) {
      throw new Error("Too many pending Jev Guard previews");
    }
    let browser: BrowserSession | undefined;
    let closing: Promise<void> | undefined;
    const reservation: SessionReservation = {
      attach: async (session) => {
        if (closing || this.#closed) {
          await session.close();
          throw new Error("Session store is closed");
        }
        if (browser) throw new Error("Session reservation already attached");
        browser = session;
        return {
          snapshot: () => session.snapshot(),
          navigate: (url) => session.navigate(url),
          close: () => reservation.release(),
        };
      },
      release: () => {
        closing ??= Promise.resolve().then(async () => {
          try { await browser?.close(); }
          finally { this.#reservations.delete(reservation); }
        });
        return closing;
      },
    };
    this.#reservations.add(reservation);
    return reservation;
  }

  async put(value: PendingNavigation, reserved?: SessionReservation): Promise<{ token: string; expiresAt: number }> {
    const reservation = reserved ?? await this.reserve();
    if (this.#closed || !this.#reservations.has(reservation)) throw new Error("Session store is closed");
    const browser = reserved ? value.browser : await reservation.attach(value.browser);

    let token = this.#tokenFactory();
    while (this.#entries.has(token)) token = this.#tokenFactory();
    const expiresAt = this.#now() + this.#ttlMs;
    const entry: StoredNavigation = { ...value, browser, token, expiresAt };
    entry.expiryTimer = setTimeout(() => {
      void this.#expire(token).catch(() => undefined);
    }, this.#ttlMs);
    entry.expiryTimer.unref();
    this.#entries.set(token, entry);
    return { token, expiresAt };
  }

  async consume(token: string): Promise<StoredNavigation> {
    if (this.#closed) throw new Error("Session store is closed");
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
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    for (const entry of entries) if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    this.#closing = Promise.allSettled([...this.#reservations].map((reservation) => reservation.release())).then((results) => {
      if (results.some((result) => result.status === "rejected")) throw new Error("Browser cleanup failed");
    });
    return this.#closing;
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
