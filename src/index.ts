#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PlaywrightBrowserDriver } from "./browser/playwright-driver.js";
import { createTypeSafeTransport, TypeSafeJevClient } from "./decision/typesafe-client.js";
import { GuardService } from "./guard/guard-service.js";
import { InteractiveBrowserDriver } from "./interactive/browser-driver.js";
import { InteractiveJevClient } from "./interactive/decision.js";
import { InteractiveSessionService } from "./interactive/session-service.js";
import { createShutdown, installStdioLifecycle } from "./lifecycle.js";
import { createMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required; use scripts/run-from-keychain.sh");

  const guard = new GuardService(
    new PlaywrightBrowserDriver(),
    new TypeSafeJevClient(createTypeSafeTransport(apiKey)),
  );
  const interactive = new InteractiveSessionService(
    new InteractiveBrowserDriver(),
    new InteractiveJevClient(createTypeSafeTransport(apiKey)),
  );
  const server = createMcpServer(guard, interactive);
  const shutdown = createShutdown([() => guard.close(), () => interactive.close(), () => server.close()]);
  installStdioLifecycle(shutdown);
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Jev Guard failed to start";
  console.error(message);
  process.exit(1);
});
