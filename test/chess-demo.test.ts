import assert from "node:assert/strict";
import test from "node:test";

import type { JevTransport } from "../src/decision/typesafe-client.js";
import { InteractiveJevClient } from "../src/interactive/decision.js";
import { InteractiveSessionService } from "../src/interactive/session-service.js";
import { startChessDemoHarness } from "../scripts/chess-demo-harness.js";
import { renderChessPage } from "../scripts/chess-demo-site.js";

test("controlled chess page starts after the bot plays f3 and offers legal black moves", () => {
  const page = renderChessPage("/game");

  assert.equal(page.status, 200);
  assert.match(page.html, /<table[^>]+aria-label="Tabuleiro de xadrez"/);
  assert.match(page.html, /Bot: f2 para f3/);
  assert.match(page.html, /href="\/game\/e7e5"[^>]*>e7 para e5/);
  assert.doesNotMatch(page.html, /href="\/game\/e2e4"/);
});

test("move URLs recompute the bot reply and final checkmate without state mutation", () => {
  const afterE5 = renderChessPage("/game/e7e5");
  const again = renderChessPage("/game/e7e5");
  const terminal = renderChessPage("/game/e7e5/d8h4");

  assert.equal(afterE5.status, 200);
  assert.equal(afterE5.html, again.html);
  assert.match(afterE5.html, /Bot: g2 para g4/);
  assert.match(afterE5.html, /href="\/game\/e7e5\/d8h4"[^>]*>d8 para h4/);
  assert.equal(terminal.status, 200);
  assert.match(terminal.html, /Jev venceu por xeque-mate/);
  assert.doesNotMatch(terminal.html, /class="legal-move"/);
});

test("controlled chess page rejects illegal and extra moves", () => {
  assert.equal(renderChessPage("/game/e7e5/a8a1").status, 404);
  assert.equal(renderChessPage("/game/e7e5/d8h4/a7a6").status, 404);
  assert.equal(renderChessPage("/game/..%2Fsecret").status, 404);
});

test("guarded browser plays both legal moves against the local bot with verified checkmate", async () => {
  const harness = await startChessDemoHarness();
  const origins = { siteOrigin: harness.origin, authOrigins: [], resourceOrigins: [] };
  const transport: JevTransport = async (request) => {
    const expectedPath = request.state.page.url.endsWith("/game") ? "/game/e7e5"
      : request.state.page.url.endsWith("/game/e7e5") ? "/game/e7e5/d8h4" : "";
    const actions = request.state.actions;
    const ids = ["done", "blocked", ...actions.map(({ id }) => id)];
    const selected = expectedPath
      ? actions.find(({ destination }) => destination.endsWith(expectedPath))?.id
      : "done";
    assert.ok(selected, `Expected move link ${expectedPath} missing`);
    return {
      model: "jev-1.13.0",
      usage: { input_tokens: 10, output_tokens: 2 },
      answers: { next: {
        type: "choice", choice: selected, confidence: 1,
        probabilities: Object.fromEntries(ids.map((id) => [id, id === selected ? 1 : 0])),
      } },
    };
  };
  const service = new InteractiveSessionService(harness.driver, new InteractiveJevClient(transport));
  try {
    const opened = await service.open({
      url: `${harness.origin}/game`, goal: "Play e7e5, then d8h4 for checkmate",
      mode: "public", origins, values: {},
      expectedResult: { kind: "text", value: "Jev venceu por xeque-mate" },
    });
    for (const path of ["/game/e7e5", "/game/e7e5/d8h4"]) {
      const preview = await service.preview(opened.sessionId);
      assert.equal(preview.status, "ready");
      if (preview.status !== "ready") return;
      assert.equal(preview.action.kind, "navigate");
      assert.equal(preview.action.destination, `${harness.origin}${path}`);
      const executed = await service.execute(preview.token);
      assert.equal(executed.status, "acted");
      assert.equal(executed.page.url, `${harness.origin}${path}`);
    }
    const done = await service.preview(opened.sessionId);
    assert.equal(done.status, "verified_done");
    assert.deepEqual(harness.requests, ["GET /game", "GET /game/e7e5", "GET /game/e7e5/d8h4"]);
  } finally {
    await service.close();
    await harness.close();
  }
});
