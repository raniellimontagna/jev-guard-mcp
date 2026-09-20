import { choice, TypeSafeClient } from "@typesafe-ai/sdk";

import { redactText } from "../security/redaction.js";
import type { Decision, DecisionInput, JevClient } from "./jev-client.js";

export const JEV_MODEL = "jev-1.13.0";
export const MIN_CONFIDENCE = 0.8;

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface TransportResponse {
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  answers: { next: ChoiceAnswer };
}

export interface TransportRequest {
  state: {
    goal: string;
    page: { url: string; title: string; text: string };
    actions: Array<{ id: string; label: string; destination: string }>;
  };
  questions: Record<string, unknown>;
  model: typeof JEV_MODEL;
}

export type JevTransport = (
  request: TransportRequest,
  options: { signal?: AbortSignal },
) => Promise<TransportResponse>;

export interface JevMetrics {
  attempts: number;
}

function validateAnswer(answer: ChoiceAnswer, offered: ReadonlySet<string>): void {
  if (answer.type !== "choice" || !offered.has(answer.choice)) {
    throw new Error("Jev answer is outside the offered action set");
  }
  if (!Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw new Error("Jev returned invalid confidence");
  }
  const probabilities = Object.values(answer.probabilities);
  if (
    probabilities.length === 0 ||
    probabilities.some((value) => !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    throw new Error("Jev returned invalid probabilities");
  }
  const probabilityKeys = Object.keys(answer.probabilities);
  if (
    probabilityKeys.length !== offered.size ||
    probabilityKeys.some((key) => !offered.has(key)) ||
    [...offered].some((key) => !(key in answer.probabilities))
  ) {
    throw new Error("Jev returned probability keys outside the offered action set");
  }
  const sum = probabilities.reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 0.001) throw new Error("Jev probabilities do not sum to one");
  const selectedProbability = answer.probabilities[answer.choice];
  const maxProbability = Math.max(...probabilities);
  if (selectedProbability === undefined || selectedProbability < maxProbability - 1e-9) {
    throw new Error("Jev selected choice is not the probability argmax");
  }
}

export function createTypeSafeTransport(apiKey: string): JevTransport {
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required");
  const client = new TypeSafeClient({
    apiKey,
    baseURL: "https://api.typesafe.ai",
    defaultModel: JEV_MODEL,
    logLevel: "off",
    retry: { maxRetries: 0 },
  });

  return async (request, options) =>
    (await client.systemOne(request as never, {
      ...(options.signal ? { signal: options.signal } : {}),
      timeout: 10_000,
      retry: { maxRetries: 0 },
    })) as unknown as TransportResponse;
}

export class TypeSafeJevClient implements JevClient {
  readonly metrics: JevMetrics = { attempts: 0 };

  constructor(
    private readonly transport: JevTransport,
    private readonly minConfidence = MIN_CONFIDENCE,
  ) {}

  async choose(input: DecisionInput, options: { signal?: AbortSignal } = {}): Promise<Decision> {
    if (input.snapshot.candidates.length === 0) {
      return {
        status: "blocked",
        confidence: 1,
        choice: "blocked",
        usage: { attempts: this.metrics.attempts, inputTokens: 0, outputTokens: 0, model: JEV_MODEL },
      };
    }

    const safeCandidates = input.snapshot.candidates.map((candidate) => ({
      id: candidate.id,
      label: redactText(candidate.label, 160),
      destination: redactText(candidate.publicUrl, 2_000),
    }));
    const criteria: Record<string, string> = {
      done: "The goal is already satisfied by the current page",
      blocked: "None of the offered safe links advances the goal",
    };
    for (const candidate of safeCandidates) {
      criteria[candidate.id] = `${candidate.label} -> ${candidate.destination}`;
    }

    const request: TransportRequest = {
      state: {
        goal: redactText(input.goal, 500),
        page: {
          url: redactText(input.snapshot.publicUrl, 2_000),
          title: redactText(input.snapshot.title, 200),
          text: redactText(input.snapshot.text, 3_000),
        },
        actions: safeCandidates,
      },
      questions: {
        next: choice("Which single safe navigation best advances the goal?", criteria),
      },
      model: JEV_MODEL,
    };

    this.metrics.attempts += 1;
    const response = await this.transport(request, options.signal ? { signal: options.signal } : {});
    if (response.model !== JEV_MODEL) {
      throw new Error(`Jev returned unexpected model: ${response.model}`);
    }
    const usageValues = [response.usage.input_tokens, response.usage.output_tokens];
    if (usageValues.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new Error("Jev returned invalid usage");
    }
    const answer = response.answers.next;
    validateAnswer(answer, new Set(Object.keys(criteria)));

    const usage = {
      attempts: this.metrics.attempts,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: response.model,
    };
    const selectedProbability = answer.probabilities[answer.choice];
    if (selectedProbability === undefined) throw new Error("Jev omitted the selected probability");
    const effectiveConfidence = Math.min(answer.confidence, selectedProbability);

    if (effectiveConfidence < this.minConfidence) {
      return { status: "low_confidence", confidence: effectiveConfidence, choice: answer.choice, usage };
    }
    if (answer.choice === "done" || answer.choice === "blocked") {
      return { status: answer.choice, confidence: effectiveConfidence, choice: answer.choice, usage };
    }

    const candidate = input.snapshot.candidates.find(({ id }) => id === answer.choice);
    if (!candidate) throw new Error("Jev answer is outside the offered action set");
    return { status: "ready", confidence: effectiveConfidence, choice: answer.choice, candidate, usage };
  }
}
