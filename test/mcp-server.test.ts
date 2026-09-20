import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ExecuteResult, PreviewResult } from "../src/guard/guard-service.js";
import { createMcpServer, type GuardApi } from "../src/mcp/server.js";

function fakeGuard(): GuardApi {
  return {
    async preview(): Promise<PreviewResult> {
      return {
        status: "blocked",
        confidence: 0.95,
        choice: "blocked",
        usage: { attempts: 1, inputTokens: 10, outputTokens: 2, model: "jev-1.13.0" },
      };
    },
    async execute(): Promise<ExecuteResult> {
      throw new Error("Preview token is invalid or already consumed");
    },
    async cancel(): Promise<{ status: "cancelled" }> {
      return { status: "cancelled" };
    },
    async close(): Promise<void> {},
  };
}

async function connected(guard = fakeGuard()) {
  const server = createMcpServer(guard);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

test("exposes only the three guarded tools with explicit annotations", async (context) => {
  const harness = await connected();
  context.after(() => harness.close());

  const result = await harness.client.listTools();
  assert.deepEqual(result.tools.map(({ name }) => name), [
    "jev_guard_preview",
    "jev_guard_execute",
    "jev_guard_cancel",
  ]);
  assert.deepEqual(result.tools[0]?.annotations, {
    title: "Preview safe Jev navigation",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  });
  assert.equal(result.tools[1]?.annotations?.readOnlyHint, false);
});

test("returns JSON content for successful previews", async (context) => {
  const harness = await connected();
  context.after(() => harness.close());

  const result = await harness.client.callTool({
    name: "jev_guard_preview",
    arguments: { url: "https://example.com/", goal: "Read documentation" },
  });
  assert.equal(result.isError, undefined);
  const content = (result.content as Array<{ type: string; text?: string }>)[0];
  assert.equal(content?.type, "text");
  if (content?.type === "text" && content.text) assert.equal(JSON.parse(content.text).status, "blocked");
});

test("returns a bounded structured tool error without a stack trace", async (context) => {
  const harness = await connected();
  context.after(() => harness.close());

  const result = await harness.client.callTool({
    name: "jev_guard_execute",
    arguments: { token: "x".repeat(43) },
  });
  const serialized = JSON.stringify(result);
  assert.equal(result.isError, true);
  assert.match(serialized, /invalid or already consumed/);
  assert.doesNotMatch(serialized, /at .*mcp-server|node_modules/);
});

test("rejects malformed input before invoking the guard", async (context) => {
  let calls = 0;
  const guard = fakeGuard();
  guard.preview = async () => {
    calls += 1;
    return {
      status: "blocked",
      confidence: 1,
      choice: "blocked",
      usage: { attempts: 0, inputTokens: 0, outputTokens: 0, model: "jev-1.13.0" },
    };
  };
  const harness = await connected(guard);
  context.after(() => harness.close());

  const result = await harness.client.callTool({
    name: "jev_guard_preview",
    arguments: { url: "not-a-url", goal: "x" },
  });
  assert.equal(result.isError, true);
  assert.equal(calls, 0);
});
