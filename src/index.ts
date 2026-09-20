#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PlaywrightBrowserDriver } from "./browser/playwright-driver.js";
import { createTypeSafeTransport, TypeSafeJevClient } from "./decision/typesafe-client.js";
import { GuardService } from "./guard/guard-service.js";
import { createMcpServer } from "./mcp/server.js";

async function main(): Promise<void> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is required; use scripts/run-from-keychain.sh");

  const guard = new GuardService(
    new PlaywrightBrowserDriver(),
    new TypeSafeJevClient(createTypeSafeTransport(apiKey)),
  );
  const server = createMcpServer(guard);
  const shutdown = async () => {
    await guard.close();
    await server.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Jev Guard failed to start";
  console.error(message);
  process.exit(1);
});
