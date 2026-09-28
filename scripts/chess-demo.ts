import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { createTypeSafeTransport } from "../src/decision/typesafe-client.js";
import { InteractiveJevClient } from "../src/interactive/decision.js";
import { InteractiveSessionService } from "../src/interactive/session-service.js";
import { startChessDemoHarness } from "./chess-demo-harness.js";

const plannedPaths = ["/game/e7e5", "/game/e7e5/d8h4"] as const;
const goal = "Play Black against the local chess bot. First choose the link e7 para e5 (e5). After White plays g2 para g4, choose d8 para h4 (Qh4#). The goal is done only when the page says Jev venceu por xeque-mate.";

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required");
  const harness = await startChessDemoHarness();
  const service = new InteractiveSessionService(
    harness.driver,
    new InteractiveJevClient(createTypeSafeTransport(apiKey)),
  );
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const opened = await service.open({
      url: `${harness.origin}/game`, goal, mode: "public",
      origins: { siteOrigin: harness.origin, authOrigins: [], resourceOrigins: [] },
      values: {}, expectedResult: { kind: "text", value: "Jev venceu por xeque-mate" },
    });
    for (const path of plannedPaths) {
      const preview = await service.preview(opened.sessionId);
      if (preview.status !== "ready") {
        console.log(JSON.stringify({ phase: "preview", status: preview.status,
          ...(preview.status !== "login_required" ? { confidence: preview.confidence } : {}) }));
        process.exitCode = 1;
        return;
      }
      const { token, sessionId: _sessionId, ...review } = preview;
      console.log(JSON.stringify({ phase: "preview", review }, null, 2));
      if (review.action.kind !== "navigate" || review.action.destination !== `${harness.origin}${path}`) {
        await service.cancel(token);
        console.log("Jev propôs outro lance. A partida foi interrompida sem executá-lo.");
        process.exitCode = 1;
        return;
      }
      let answer = "";
      try {
        answer = await input.question("Digite aprovar para executar exatamente este lance: ", {
          signal: AbortSignal.timeout(110_000),
        });
      } catch {
        console.log("Aprovação não recebida dentro do prazo.");
      }
      if (answer.trim() !== "aprovar") {
        await service.cancel(token).catch(() => undefined);
        console.log("Lance cancelado.");
        process.exitCode = 1;
        return;
      }
      const result = await service.execute(token);
      console.log(JSON.stringify({ phase: "execute", status: result.status, action: result.action, page: {
        url: result.page.url, title: result.page.title,
      } }, null, 2));
      if (result.status !== "acted" || result.page.url !== `${harness.origin}${path}`) {
        process.exitCode = 1;
        return;
      }
    }
    const directory = join(process.cwd(), "artifacts");
    await mkdir(directory, { recursive: true });
    const screenshotPath = join(directory, "chess-demo-final.png");
    await harness.screenshot(screenshotPath);
    const done = await service.preview(opened.sessionId);
    console.log(JSON.stringify({ phase: "result", status: done.status,
      ...(done.status !== "login_required" ? { confidence: done.confidence } : {}) }, null, 2));
    if (done.status !== "verified_done") {
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ phase: "evidence", screenshotPath, requests: harness.requests }, null, 2));
  } finally {
    input.close();
    await service.close();
    await harness.close();
  }
}

main().catch((error: unknown) => {
  console.error("Demonstração interrompida:", error instanceof Error ? error.name : "erro desconhecido");
  process.exitCode = 1;
});
