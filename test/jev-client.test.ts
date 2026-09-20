import assert from "node:assert/strict";
import test from "node:test";

import type { PageSnapshot } from "../src/contracts.js";
import {
  TypeSafeJevClient,
  type JevTransport,
  type TransportResponse,
} from "../src/decision/typesafe-client.js";

const snapshot: PageSnapshot = {
  sourceUrl: "https://example.com/start?session=secret",
  publicUrl: "https://example.com/start",
  title: "Example",
  text: "Welcome [REDACTED_EMAIL]",
  candidates: [
    {
      id: "link_0",
      label: "Documentation",
      url: "https://example.com/docs",
      publicUrl: "https://example.com/docs",
      fingerprint: "a".repeat(64),
    },
  ],
};

function response(choice: string, confidence: number, probabilities?: Record<string, number>): TransportResponse {
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      next: {
        type: "choice",
        choice,
        confidence,
        probabilities: probabilities ?? { done: 0, blocked: 0, link_0: 0, [choice]: 1 },
      },
    },
  };
}

function clientWith(answer: TransportResponse): TypeSafeJevClient {
  return new TypeSafeJevClient(async () => answer);
}

test("rejects an answer outside the bounded choice set", async () => {
  const client = clientWith(response("invented", 0.99));
  await assert.rejects(() => client.choose({ goal: "Read docs", snapshot }), /outside the offered action set/);
});

test("returns no executable candidate below the confidence floor", async () => {
  const decision = await clientWith(response("link_0", 0.79)).choose({ goal: "Read docs", snapshot });
  assert.deepEqual(decision, {
    status: "low_confidence",
    confidence: 0.79,
    choice: "link_0",
    usage: { attempts: 1, inputTokens: 100, outputTokens: 20, model: "jev-1.13.0" },
  });
});

test("uses the lower of reported confidence and selected probability for the safety floor", async () => {
  const decision = await clientWith(
    response("link_0", 0.99, { done: 0.33, blocked: 0.33, link_0: 0.34 }),
  ).choose({ goal: "Read docs", snapshot });

  assert.equal(decision.status, "low_confidence");
  assert.equal(decision.confidence, 0.34);
});

test("maps a confident bounded choice to its code-owned candidate", async () => {
  const decision = await clientWith(response("link_0", 0.93, { done: 0.02, blocked: 0.05, link_0: 0.93 })).choose({
    goal: "Read docs",
    snapshot,
  });
  assert.equal(decision.status, "ready");
  if (decision.status === "ready") assert.equal(decision.candidate.id, "link_0");
});

test("maps confident terminal choices without an action", async () => {
  assert.equal((await clientWith(response("done", 0.91)).choose({ goal: "Read docs", snapshot })).status, "done");
  assert.equal((await clientWith(response("blocked", 0.92)).choose({ goal: "Read docs", snapshot })).status, "blocked");
});

test("returns blocked without calling Jev when there are no candidates", async () => {
  let calls = 0;
  const client = new TypeSafeJevClient(async () => {
    calls += 1;
    return response("blocked", 1);
  });
  const decision = await client.choose({ goal: "Read docs", snapshot: { ...snapshot, candidates: [] } });
  assert.equal(decision.status, "blocked");
  assert.equal(calls, 0);
  assert.equal(client.metrics.attempts, 0);
});

test("counts an attempt before a failed transport call and forwards cancellation", async () => {
  const controller = new AbortController();
  const transport: JevTransport = async (_request, options) => {
    assert.equal(options.signal, controller.signal);
    throw new Error("transport failed");
  };
  const client = new TypeSafeJevClient(transport);

  await assert.rejects(
    () => client.choose({ goal: "Read docs", snapshot }, { signal: controller.signal }),
    /transport failed/,
  );
  assert.equal(client.metrics.attempts, 1);
});

test("never sends query strings, source URLs or unredacted goal data", async () => {
  const transport: JevTransport = async (request) => {
    const serialized = JSON.stringify(request);
    assert.doesNotMatch(serialized, /session=secret/);
    assert.doesNotMatch(serialized, /me@example\.com/);
    assert.match(serialized, /\[REDACTED_EMAIL\]/);
    return response("link_0", 0.9);
  };
  await new TypeSafeJevClient(transport).choose({ goal: "Send to me@example.com", snapshot });
});

test("rejects malformed confidence and probabilities", async () => {
  await assert.rejects(
    () => clientWith(response("link_0", Number.NaN)).choose({ goal: "Read docs", snapshot }),
    /invalid confidence/,
  );
  await assert.rejects(
    () =>
      clientWith(response("link_0", 0.9, { done: 0, blocked: 0, link_0: Number.POSITIVE_INFINITY })).choose({
        goal: "Read docs",
        snapshot,
      }),
    /invalid probabilities/,
  );
});

test("rejects an unpinned response model and malformed usage", async () => {
  await assert.rejects(
    () =>
      clientWith({ ...response("link_0", 0.9), model: "jev-latest" }).choose({
        goal: "Read docs",
        snapshot,
      }),
    /unexpected model/,
  );
  await assert.rejects(
    () =>
      clientWith({
        ...response("link_0", 0.9),
        usage: { input_tokens: -1, output_tokens: Number.NaN },
      }).choose({ goal: "Read docs", snapshot }),
    /invalid usage/,
  );
});

test("rejects probability keys outside the offered set", async () => {
  await assert.rejects(
    () =>
      clientWith(response("link_0", 0.9, { done: 0, blocked: 0, link_0: 0.9, invented: 0.1 })).choose({
        goal: "Read docs",
        snapshot,
      }),
    /probability keys/,
  );
});

test("rejects distributions that do not sum to one or disagree with the selected argmax", async () => {
  await assert.rejects(
    () =>
      clientWith(response("link_0", 0.9, { done: 0.1, blocked: 0.1, link_0: 0.3 })).choose({
        goal: "Read docs",
        snapshot,
      }),
    /sum to one/,
  );
  await assert.rejects(
    () =>
      clientWith(response("link_0", 0.9, { done: 0.7, blocked: 0.1, link_0: 0.2 })).choose({
        goal: "Read docs",
        snapshot,
      }),
    /selected choice is not the probability argmax/,
  );
});
