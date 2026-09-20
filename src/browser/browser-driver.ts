import type { PageSnapshot } from "../contracts.js";

export interface BrowserSession {
  snapshot(): Promise<PageSnapshot>;
  navigate(url: string): Promise<PageSnapshot>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  open(url: string): Promise<BrowserSession>;
}
