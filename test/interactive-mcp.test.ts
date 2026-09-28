import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/mcp/server.js";
import type { GuardApi } from "../src/mcp/server.js";
import type { InteractiveOpenRequest } from "../src/interactive/session-service.js";

const id = "s".repeat(43);
const token = "t".repeat(43);
const usage = { attempts: 1, inputTokens: 2, outputTokens: 3, model: "jev-1.13.0" };

function fakeGuard(): GuardApi {
  return {
    preview: async () => ({ status: "blocked", choice: "blocked", confidence: 1, usage }),
    execute: async () => { throw new Error("Preview token is invalid or already consumed"); },
    cancel: async () => ({ status: "cancelled" }),
    close: async () => undefined,
  };
}

function fakeInteractive() {
  const calls: string[] = [];
  let opened: InteractiveOpenRequest | undefined;
  return {
    calls,
    get opened() { return opened; },
    async open(request: InteractiveOpenRequest) {
      calls.push("open"); opened = request;
      return { sessionId: id, status: "ready" as const, expiresAt: "2026-09-28T12:00:00.000Z" };
    },
    async preview(sessionId: string) {
      calls.push(`preview:${sessionId}`);
      return { status: "ready" as const, sessionId, token, expiresAt: "2026-09-28T12:00:00.000Z",
        sourceUrl: "https://example.com/start", confidence: 0.9,
        action: { id: "action_0", kind: "navigate" as const, label: "Next", destination: "https://example.com/next" }, usage };
    },
    async execute(approvalToken: string) {
      calls.push(`execute:${approvalToken}`);
      return { status: "acted" as const, sessionId: id,
        action: { id: "action_0", kind: "navigate" as const, label: "Next", destination: "https://example.com/next" },
        page: { url: "https://example.com/next", title: "Next", text: "Done" }, usage };
    },
    async cancel(approvalToken: string) { calls.push(`cancel:${approvalToken}`); return { status: "cancelled" as const }; },
    async closeSession(sessionId: string) { calls.push(`close:${sessionId}`); return { status: "closed" as const }; },
    async close() { calls.push("shutdown"); },
  };
}

async function connected(interactive = fakeInteractive()) {
  const server = createMcpServer(fakeGuard(), interactive);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, interactive, async close() { await client.close(); await server.close(); } };
}

test("adds five supervised tools after the original three with explicit approval annotations", async (context) => {
  const harness = await connected();
  context.after(() => harness.close());
  const tools = (await harness.client.listTools()).tools;
  assert.deepEqual(tools.map(({ name }) => name), [
    "jev_guard_preview", "jev_guard_execute", "jev_guard_cancel",
    "jev_browser_open", "jev_browser_preview", "jev_browser_execute", "jev_browser_cancel", "jev_browser_close",
  ]);
  const execute = tools.find(({ name }) => name === "jev_browser_execute");
  assert.equal(execute?.annotations?.readOnlyHint, false);
  assert.equal(execute?.annotations?.destructiveHint, true);
  assert.equal(execute?.annotations?.idempotentHint, false);
  assert.match(execute?.description ?? "", /explicit human approval/i);
  assert.match(execute?.description ?? "", /cannot.*attest.*approval/i);
});

test("open accepts exact public origins and bounded values; each lifecycle tool calls one service method", async (context) => {
  const harness = await connected();
  context.after(() => harness.close());
  const opened = await harness.client.callTool({ name: "jev_browser_open", arguments: {
    url: "https://example.com/start", goal: "Read next", mode: "public",
    origins: { siteOrigin: "https://example.com", authOrigins: [], resourceOrigins: [] },
    values: { message_value: "SYNTHETIC_TEXT" },
    expectedResult: { kind: "url", value: "https://example.com/next" },
  } });
  assert.equal(opened.isError, undefined);
  assert.equal(harness.interactive.opened?.values.message_value, "SYNTHETIC_TEXT");
  for (const [name, args] of [
    ["jev_browser_preview", { sessionId: id }], ["jev_browser_execute", { token }],
    ["jev_browser_cancel", { token }], ["jev_browser_close", { sessionId: id }],
  ] as const) {
    const result = await harness.client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, name);
  }
  assert.deepEqual(harness.interactive.calls, ["open", `preview:${id}`, `execute:${token}`, `cancel:${token}`, `close:${id}`]);
});

test("schema rejects unsafe origins, credential keys and missing auth opt-in before opening", async (context) => {
  const harness = await connected();
  context.after(() => harness.close());
  const base = {
    url: "https://example.com/start", goal: "Read", mode: "public",
    origins: { siteOrigin: "https://example.com", authOrigins: [], resourceOrigins: [] }, values: {},
  };
  for (const args of [
    { ...base, origins: { ...base.origins, siteOrigin: "https://example.com/path" } },
    { ...base, origins: { ...base.origins, siteOrigin: "https://127.0.0.1" } },
    { ...base, values: { account_password: "SYNTHETIC_SECRET" } },
    { ...base, mode: "auth" },
  ]) {
    const result = await harness.client.callTool({ name: "jev_browser_open", arguments: args });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(harness.interactive.calls, []);

  const longPrivateValue = "SYNTHETIC_PRIVATE_VALUE".repeat(100);
  const invalidValue = await harness.client.callTool({ name: "jev_browser_open", arguments: {
    ...base, values: { message_value: longPrivateValue },
  } });
  assert.equal(invalidValue.isError, true);
  assert.doesNotMatch(JSON.stringify(invalidValue), /SYNTHETIC_PRIVATE_VALUE/);
});

test("dependency errors use fixed bounded messages without URL, values or stack", async (context) => {
  const interactive = fakeInteractive();
  interactive.execute = async () => {
    throw new Error("page.goto https://example.com/start?secret=SYNTHETIC_SECRET\n at /Users/test/node_modules/x.js");
  };
  const harness = await connected(interactive);
  context.after(() => harness.close());
  const result = await harness.client.callTool({ name: "jev_browser_execute", arguments: { token } });
  assert.equal(result.isError, true);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /OPERATION_FAILED/);
  assert.doesNotMatch(serialized, /SYNTHETIC_SECRET|example\.com|\/Users|node_modules/);
  assert.ok(serialized.length < 300);
});
