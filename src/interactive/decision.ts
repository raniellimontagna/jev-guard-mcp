import { choice } from "@typesafe-ai/sdk";

import type { DecisionUsage } from "../decision/jev-client.js";
import {
  JEV_MODEL,
  MIN_CONFIDENCE,
  validateAnswer,
  type JevTransport,
  type TransportRequest,
} from "../decision/typesafe-client.js";
import { redactText } from "../security/redaction.js";
import type { ActionCandidate, InteractiveSnapshot } from "./contracts.js";

export interface InteractiveDecisionInput {
  goal: string;
  snapshot: InteractiveSnapshot;
  valueKeys: readonly string[];
}

export type InteractiveDecision =
  | { status: "ready"; confidence: number; choice: string; candidate: ActionCandidate; usage: DecisionUsage }
  | { status: "done" | "blocked" | "low_confidence"; confidence: number; choice: string; usage: DecisionUsage };

export class InteractiveJevClient {
  readonly metrics = { attempts: 0 };

  constructor(
    private readonly transport: JevTransport,
    private readonly minConfidence = MIN_CONFIDENCE,
  ) {}

  async choose(input: InteractiveDecisionInput, options: { signal?: AbortSignal } = {}): Promise<InteractiveDecision> {
    const { snapshot } = input;
    if (snapshot.candidates.length === 0) {
      return {
        status: "blocked",
        confidence: 1,
        choice: "blocked",
        usage: { attempts: this.metrics.attempts, inputTokens: 0, outputTokens: 0, model: JEV_MODEL },
      };
    }

    const criteria: Record<string, string> = {
      done: "The observed page already satisfies the goal",
      blocked: "No offered action safely advances the goal",
    };
    for (const action of snapshot.modelActions) {
      criteria[action.id] = [action.kind, action.label, action.valueKey ?? "", action.destination].filter(Boolean).join(" | ");
    }
    const request: TransportRequest = {
      state: {
        goal: redactText(input.goal, 500),
        page: {
          url: snapshot.publicUrl,
          title: snapshot.title,
          text: snapshot.modelText,
        },
        actions: snapshot.modelActions,
      },
      questions: { next: choice("Which one offered action best advances the goal?", criteria) },
      model: JEV_MODEL,
    };

    this.metrics.attempts += 1;
    const response = await this.transport(request, options.signal ? { signal: options.signal } : {});
    if (response.model !== JEV_MODEL) throw new Error("Jev returned unexpected model");
    const usageValues = [response.usage.input_tokens, response.usage.output_tokens];
    if (usageValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("Jev returned invalid usage");
    }
    const answer = response.answers.next;
    validateAnswer(answer, new Set(Object.keys(criteria)));
    const selectedProbability = answer.probabilities[answer.choice];
    if (selectedProbability === undefined) throw new Error("Jev omitted the selected probability");
    const confidence = Math.min(answer.confidence, selectedProbability);
    const usage: DecisionUsage = {
      attempts: this.metrics.attempts,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: response.model,
    };

    if (confidence < this.minConfidence) return { status: "low_confidence", confidence, choice: answer.choice, usage };
    if (answer.choice === "done" || answer.choice === "blocked") {
      return { status: answer.choice, confidence, choice: answer.choice, usage };
    }
    const candidate = snapshot.candidates.find(({ id }) => id === answer.choice);
    if (!candidate) throw new Error("Jev answer is outside the offered action set");
    return { status: "ready", confidence, choice: answer.choice, candidate, usage };
  }
}
