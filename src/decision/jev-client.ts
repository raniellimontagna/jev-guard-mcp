import type { LinkCandidate, PageSnapshot } from "../contracts.js";

export interface DecisionInput {
  goal: string;
  snapshot: PageSnapshot;
}

export interface DecisionUsage {
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

interface BaseDecision {
  confidence: number;
  choice: string;
  usage: DecisionUsage;
}

export interface ReadyDecision extends BaseDecision {
  status: "ready";
  candidate: LinkCandidate;
}

export interface TerminalDecision extends BaseDecision {
  status: "done" | "blocked" | "low_confidence";
}

export type Decision = ReadyDecision | TerminalDecision;

export interface JevClient {
  choose(input: DecisionInput, options?: { signal?: AbortSignal }): Promise<Decision>;
}
