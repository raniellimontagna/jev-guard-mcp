import assert from "node:assert/strict";
import test from "node:test";

import { InteractiveJevClient } from "../src/interactive/decision.js";
import { buildInteractiveSnapshot } from "../src/interactive/snapshot.js";
import type { JevTransport, TransportResponse } from "../src/decision/typesafe-client.js";

const snapshot = buildInteractiveSnapshot({
  url: "https://example.com/inquiry?session=PRIVATE_QUERY",
  title: "Contact client@example.com",
  text: "Message for client@example.com",
  elements: [
    { domIndex: 0, kind: "field", label: "Email", name: "email", fieldType: "email", visible: true, enabled: true },
    {
      domIndex: 1, kind: "submit", label: "Send", visible: true, enabled: true,
      form: {
        action: "https://example.com/send?csrf=PRIVATE_QUERY",
        method: "POST", hasFileInput: false,
        fields: [{ name: "email", value: "PRIVATE_VALUE", hidden: false }, { name: "csrf", value: "PRIVATE_CSRF", hidden: true }],
      },
    },
  ],
}, { siteOrigin: "https://example.com" }, ["contact_email"]);

function response(choice: string, confidence = 0.91): TransportResponse {
  const probabilities = { done: 0.03, blocked: 0.03, action_0: 0.91, action_1: 0.03 };
  return {
    model: "jev-1.13.0",
    usage: { input_tokens: 80, output_tokens: 10 },
    answers: { next: { type: "choice", choice, confidence, probabilities } },
  };
}

test("sends only bounded redacted action metadata to TypeSafe", async () => {
  const transport: JevTransport = async (request) => {
    const serialized = JSON.stringify(request);
    assert.match(serialized, /contact_email/);
    assert.match(serialized, /\[REDACTED_EMAIL\]/);
    assert.doesNotMatch(serialized, /PRIVATE_VALUE|PRIVATE_CSRF|PRIVATE_QUERY|client@example\.com|secret@example\.com/);
    assert.deepEqual(request.state.actions.map(({ id }) => id), ["action_0", "action_1"]);
    return response("action_0");
  };
  const decision = await new InteractiveJevClient(transport).choose({
    goal: "Fill the address for secret@example.com",
    snapshot,
    valueKeys: ["contact_email"],
  });
  assert.equal(decision.status, "ready");
  if (decision.status === "ready") assert.equal(decision.candidate.id, "action_0");
});

test("rejects invented choices and malformed probability distributions", async () => {
  await assert.rejects(
    new InteractiveJevClient(async () => ({ ...response("invented"), answers: { next: { ...response("invented").answers.next, probabilities: { done: 0.03, blocked: 0.03, action_0: 0.91, invented: 0.03 } } } })).choose({ goal: "x", snapshot, valueKeys: [] }),
    /outside the offered action set|probability keys/,
  );
});

test("returns low confidence without an executable candidate", async () => {
  const low = response("action_0", 0.79);
  const decision = await new InteractiveJevClient(async () => low).choose({ goal: "x", snapshot, valueKeys: [] });
  assert.equal(decision.status, "low_confidence");
});

test("counts a failed transport call once and never calls it without candidates", async () => {
  let calls = 0;
  const client = new InteractiveJevClient(async () => {
    calls += 1;
    throw new Error("model unavailable");
  });
  await assert.rejects(client.choose({ goal: "x", snapshot, valueKeys: [] }), /model unavailable/);
  assert.equal(client.metrics.attempts, 1);
  const empty = { ...snapshot, candidates: [], modelActions: [] };
  assert.equal((await client.choose({ goal: "x", snapshot: empty, valueKeys: [] })).status, "blocked");
  assert.equal(calls, 1);
});
