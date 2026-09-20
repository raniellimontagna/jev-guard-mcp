import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type {
  ExecuteResult,
  PreviewRequest,
  PreviewResult,
} from "../guard/guard-service.js";

export interface GuardApi {
  preview(request: PreviewRequest, options?: { signal?: AbortSignal }): Promise<PreviewResult>;
  execute(token: string): Promise<ExecuteResult>;
  cancel(token: string): Promise<{ status: "cancelled" }>;
  close(): Promise<void>;
}

function success(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

const PUBLIC_ERRORS = new Map<string, { code: string; error: string }>([
  ["Preview token is invalid or already consumed", { code: "INVALID_TOKEN", error: "Preview token is invalid or already consumed" }],
  ["Preview token expired", { code: "EXPIRED_TOKEN", error: "Preview token expired" }],
  ...["Preview is stale: source URL changed", "Preview is stale: candidate changed or disappeared"].map((message): [string, { code: string; error: string }] => [message, { code: "STALE_PREVIEW", error: "Preview is stale; request a new preview" }]),
  ...["Jev Guard is closed", "Session store is closed", "Browser session is closed"].map((message): [string, { code: string; error: string }] => [message, { code: "CLOSED", error: "Jev Guard is closed" }]),
  ...["URL is invalid", "Only HTTPS URLs are allowed", "Embedded URL credentials are not allowed", "URL must use a public hostname", "Hostname did not resolve", "Cross-origin navigation is blocked", "Navigation URL is outside the approved policy"].map((message): [string, { code: string; error: string }] => [message, { code: "URL_REJECTED", error: "URL rejected by navigation policy" }]),
  ["Too many pending Jev Guard previews", { code: "CAPACITY_EXCEEDED", error: "Too many pending Jev Guard previews" }],
  ["Goal must not be empty", { code: "INVALID_GOAL", error: "Goal must not be empty" }],
]);

function failure(error: unknown) {
  // Map only known errors to constants; never echo dependency error text.
  const message = error instanceof Error ? error.message : "";
  const knownError = PUBLIC_ERRORS.get(message)
    ?? (/^Hostname resolved to a non-public address: [0-9a-f:.]+$/i.test(message)
      ? { code: "URL_REJECTED", error: "URL rejected by navigation policy" }
      : undefined);
  const payload = knownError
    ?? { code: "OPERATION_FAILED", error: "Jev Guard operation failed" };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export function createMcpServer(guard: GuardApi): McpServer {
  const server = new McpServer({ name: "jev-guard-mcp", version: "0.1.0" });

  server.registerTool(
    "jev_guard_preview",
    {
      title: "Preview safe Jev navigation",
      description:
        "Open a public HTTPS page in a fresh browser profile and ask Jev to preview one same-origin, query-free link. This tool never executes the proposed navigation.",
      inputSchema: {
        url: z.string().url().startsWith("https://").describe("Public HTTPS page to inspect"),
        goal: z.string().trim().min(1).max(500).describe("What information or destination should be found"),
      },
      annotations: {
        title: "Preview safe Jev navigation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, goal }, extra) => {
      try {
        return success(await guard.preview({ url, goal }, { signal: extra.signal }));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "jev_guard_execute",
    {
      title: "Execute previewed Jev navigation",
      description:
        "Consume one preview token and perform exactly its fresh, same-origin navigation. A trusted MCP client must show the source, label and destination and obtain explicit human approval before calling execute. Possession of a preview token is technical authorization; the server cannot independently attest human approval.",
      inputSchema: {
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).describe("Single-use token returned by jev_guard_preview"),
      },
      annotations: {
        title: "Execute previewed Jev navigation",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ token }) => {
      try {
        return success(await guard.execute(token));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "jev_guard_cancel",
    {
      title: "Cancel previewed Jev navigation",
      description: "Consume a pending preview token without navigating and close its isolated browser.",
      inputSchema: {
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).describe("Single-use token returned by jev_guard_preview"),
      },
      annotations: {
        title: "Cancel previewed Jev navigation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ token }) => {
      try {
        return success(await guard.cancel(token));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
