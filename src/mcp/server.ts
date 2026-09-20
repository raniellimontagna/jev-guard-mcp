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

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Jev Guard operation failed";
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
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
        "Consume one preview token and perform exactly its fresh, same-origin navigation. Call only after the user explicitly approves the exact source, label and destination returned by jev_guard_preview.",
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
