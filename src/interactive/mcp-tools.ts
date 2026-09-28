import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import { validateStartUrl } from "../security/url-policy.js";
import type {
  InteractiveExecuteResult, InteractiveOpenRequest, InteractivePreviewResult,
} from "./session-service.js";
import { safeValueKey } from "./snapshot.js";

export interface InteractiveApi {
  open(request: InteractiveOpenRequest): Promise<{ sessionId: string; status: "ready" | "manual_login_pending"; expiresAt: string }>;
  preview(sessionId: string): Promise<InteractivePreviewResult>;
  execute(token: string): Promise<InteractiveExecuteResult>;
  cancel(token: string): Promise<{ status: "cancelled" }>;
  closeSession(sessionId: string): Promise<{ status: "closed" }>;
  close(): Promise<void>;
}

const httpsUrl = z.string().max(2048).url().refine((value) => {
  try { validateStartUrl(value); return true; }
  catch { return false; }
}, "Public HTTPS URL required");

const exactOrigin = httpsUrl.refine((value) => {
  const url = new URL(value);
  return url.pathname === "/" && !url.search && !url.hash;
}, "An exact HTTPS origin is required");

const origins = z.object({
  siteOrigin: exactOrigin,
  authOrigins: z.array(exactOrigin).max(10),
  resourceOrigins: z.array(exactOrigin).max(10),
});

const values = z.record(
  z.string().refine(safeValueKey, "Non-credential semantic key required"),
  z.string().max(1000).refine((value) => !value.includes("\0"), "Invalid value"),
).refine((record) => Object.keys(record).length <= 20, "Too many values");

const id = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

function success(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const PUBLIC_ERRORS = new Map<string, { code: string; error: string }>([
  ["Interactive token is invalid or already consumed", { code: "INVALID_TOKEN", error: "Interactive approval token is invalid or consumed" }],
  ["Interactive token expired", { code: "EXPIRED_TOKEN", error: "Interactive approval token expired" }],
  ["Interactive preview is stale", { code: "STALE_PREVIEW", error: "Interactive preview changed; open a new session" }],
  ["Interactive session is invalid or closed", { code: "INVALID_SESSION", error: "Interactive session is invalid or closed" }],
  ["Interactive session expired", { code: "EXPIRED_SESSION", error: "Interactive session expired" }],
  ["Interactive session is busy", { code: "BUSY", error: "Interactive session is busy" }],
  ["Interactive preview is already pending", { code: "PREVIEW_PENDING", error: "Resolve the pending preview first" }],
  ["Interactive session capacity exceeded", { code: "CAPACITY_EXCEEDED", error: "Interactive session capacity exceeded" }],
  ["Interactive browser is closed", { code: "CLOSED", error: "Interactive browser is closed" }],
  ["Authenticated browsing requires page-text sharing opt-in", { code: "DATA_SHARING_REQUIRED", error: "Authenticated browsing requires page-text sharing opt-in" }],
  ["Interactive values are invalid or credential-like", { code: "INVALID_VALUES", error: "Interactive values are invalid" }],
  ["Goal must not be empty", { code: "INVALID_GOAL", error: "Goal must not be empty" }],
]);

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const payload = PUBLIC_ERRORS.get(message) ?? { code: "OPERATION_FAILED", error: "Interactive browser operation failed" };
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function registerInteractiveTools(server: McpServer, api: InteractiveApi): void {
  server.registerTool("jev_browser_open", {
    title: "Open supervised Jev browser session",
    description: "Open a new isolated HTTPS browser for public reading or user-performed manual login. Authenticated page text is sent redacted to TypeSafe only after explicit opt-in; redaction is imperfect. Values remain local. Opening the specified URL is a user-directed browser action.",
    inputSchema: {
      url: httpsUrl.describe("Start URL on the exact site origin"),
      goal: z.string().trim().min(1).max(500),
      mode: z.enum(["public", "auth"]),
      origins,
      values: values.default({}),
      shareRedactedPageTextWithTypeSafe: z.boolean().optional(),
      expectedResult: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("url"), value: httpsUrl }),
        z.object({ kind: z.literal("text"), value: z.string().min(1).max(200) }),
      ]).optional(),
    },
    annotations: { title: "Open supervised Jev browser session", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (request) => {
    try {
      if (request.mode === "auth" && request.shareRedactedPageTextWithTypeSafe !== true) {
        return failure(new Error("Authenticated browsing requires page-text sharing opt-in"));
      }
      return success(await api.open({
        url: request.url,
        goal: request.goal,
        mode: request.mode,
        origins: request.origins,
        values: request.values,
        ...(request.shareRedactedPageTextWithTypeSafe === undefined ? {} : {
          shareRedactedPageTextWithTypeSafe: request.shareRedactedPageTextWithTypeSafe,
        }),
        ...(request.expectedResult === undefined ? {} : { expectedResult: request.expectedResult }),
      }));
    } catch (error) { return failure(error); }
  });

  server.registerTool("jev_browser_preview", {
    title: "Preview one Jev browser action",
    description: "Observe the current page and obtain one Jev-selected, code-owned action. Returns source, label, destination, confidence, relevant exact value or form payload, and a short-lived token; executes nothing. For auth mode, call after the user completes manual login.",
    inputSchema: { sessionId: id },
    annotations: { title: "Preview one Jev browser action", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ sessionId }) => {
    try { return success(await api.preview(sessionId)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("jev_browser_execute", {
    title: "Execute one approved Jev browser action",
    description: "Consume one preview token and perform its exact fresh action, including a possible form POST. A trusted MCP client must show source, label, destination, confidence, relevant value and form payload and obtain explicit human approval before calling execute. The server cannot independently attest human approval. Never retry an uncertain submission.",
    inputSchema: { token: id },
    annotations: { title: "Execute one approved Jev browser action", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ token }) => {
    try { return success(await api.execute(token)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("jev_browser_cancel", {
    title: "Cancel a Jev browser approval",
    description: "Consume a pending browser approval token and close its isolated session without executing the proposed action.",
    inputSchema: { token: id },
    annotations: { title: "Cancel a Jev browser approval", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ token }) => {
    try { return success(await api.cancel(token)); }
    catch (error) { return failure(error); }
  });

  server.registerTool("jev_browser_close", {
    title: "Close a supervised Jev browser session",
    description: "Close the isolated browser session and discard its in-memory values and pending approval.",
    inputSchema: { sessionId: id },
    annotations: { title: "Close a supervised Jev browser session", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ sessionId }) => {
    try { return success(await api.closeSession(sessionId)); }
    catch (error) { return failure(error); }
  });
}
