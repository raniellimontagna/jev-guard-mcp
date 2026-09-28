import assert from "node:assert/strict";
import test from "node:test";
import { connect, createServer as createTcpServer } from "node:net";
import type { BrowserContext, Page, Route } from "playwright";

import { EgressProxy } from "../src/interactive/egress-proxy.js";
import { installInteractiveNetworkPolicy, InteractiveNetworkPolicy } from "../src/interactive/network-policy.js";

const origins = {
  siteOrigin: "https://example.com",
  authOrigins: ["https://login.example.com"],
  resourceOrigins: ["https://cdn.example.com"],
};

test("manual login allows only listed HTTPS origins and disallows resource POST", () => {
  const policy = new InteractiveNetworkPolicy(origins, "auth", "https://example.com/login");
  assert.equal(policy.allow({ url: "https://login.example.com/session", method: "POST", resourceType: "document", isMainFrame: true }), true);
  assert.equal(policy.allow({ url: "https://cdn.example.com/app.js", method: "GET", resourceType: "script", isMainFrame: false }), true);
  assert.equal(policy.allow({ url: "https://cdn.example.com/collect", method: "POST", resourceType: "fetch", isMainFrame: false }), false);
  assert.equal(policy.allow({ url: "https://other.example/api", method: "GET", resourceType: "fetch", isMainFrame: false }), false);
  assert.equal(policy.allow({ url: "http://example.com/insecure", method: "GET", resourceType: "document", isMainFrame: true }), false);
});

test("supervised phase blocks mutation and unapproved documents", () => {
  const policy = new InteractiveNetworkPolicy(origins, "public", "https://example.com/start");
  assert.equal(policy.allow({ url: "https://example.com/start", method: "GET", resourceType: "document", isMainFrame: true }), true);
  policy.enterSupervised();
  assert.equal(policy.allow({ url: "https://example.com/api", method: "POST", resourceType: "fetch", isMainFrame: false }), false);
  assert.equal(policy.allow({ url: "https://example.com/next", method: "GET", resourceType: "document", isMainFrame: true }), false);
  policy.approveDocument("https://example.com/next");
  assert.equal(policy.allow({ url: "https://example.com/next", method: "GET", resourceType: "document", isMainFrame: true }), true);
  assert.equal(policy.allow({ url: "https://example.com/next", method: "GET", resourceType: "document", isMainFrame: true }), false);
  assert.equal(policy.allow({ url: "https://other.example/frame", method: "GET", resourceType: "document", isMainFrame: false }), false);
});

test("fill locks all requests and approved POST is single-use", () => {
  const policy = new InteractiveNetworkPolicy(origins, "public", "https://example.com/start");
  policy.enterSupervised();
  policy.lockAfterValue();
  assert.equal(policy.allow({ url: "https://example.com/collect?value=secret", method: "GET", resourceType: "image", isMainFrame: false }), false);
  assert.equal(policy.allow({ url: "https://example.com/api", method: "POST", resourceType: "fetch", isMainFrame: false }), false);
  policy.approveSubmission({ method: "POST", url: "https://example.com/send" });
  assert.equal(policy.allow({ url: "https://example.com/send?extra=x", method: "POST", resourceType: "document", isMainFrame: true }), false);
  assert.equal(policy.allow({ url: "https://example.com/send", method: "POST", resourceType: "document", isMainFrame: true }), true);
  assert.equal(policy.allow({ url: "https://example.com/send", method: "POST", resourceType: "document", isMainFrame: true }), false);
  assert.equal(policy.submissionResult(), "outcome_unknown");
  policy.recordSubmissionResponse(200);
  assert.equal(policy.submissionResult(), "submitted");
});

test("supervised redirect is blocked and manual redirect needs an allowed origin", () => {
  const publicPolicy = new InteractiveNetworkPolicy(origins, "public", "https://example.com/start");
  publicPolicy.enterSupervised();
  assert.equal(publicPolicy.allowRedirect("https://example.com/start", "/next"), false);
  const authPolicy = new InteractiveNetworkPolicy(origins, "auth", "https://example.com/login");
  assert.equal(authPolicy.allowRedirect("https://example.com/login", "https://login.example.com/continue"), true);
  assert.equal(authPolicy.allowRedirect("https://example.com/login", "http://127.0.0.1/private"), false);
});

async function connectResponse(port: number, authority: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.once("data", (data) => { resolve(data.toString()); socket.destroy(); });
  });
}

test("CONNECT proxy rejects unlisted destinations before opening a remote socket", async () => {
  const proxy = await EgressProxy.start(["https://example.com"]);
  try {
    assert.match(await connectResponse(proxy.port, "127.0.0.1:443"), /^HTTP\/1\.1 403/);
  } finally {
    await proxy.close();
  }
});

test("CONNECT proxy rejects a listed host whose DNS resolves privately", async () => {
  const proxy = await EgressProxy.start(["https://example.com"], {
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  try {
    assert.match(await connectResponse(proxy.port, "example.com:443"), /^HTTP\/1\.1 403/);
  } finally {
    await proxy.close();
  }
});

test("CONNECT proxy dials the checked public IP and tunnels bytes", async () => {
  const target = createTcpServer((socket) => socket.once("data", (data) => socket.write(`reply:${data.toString()}`)));
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  assert.ok(address && typeof address !== "string");
  const dials: string[] = [];
  const proxy = await EgressProxy.start(["https://example.com"], {
    lookup: async () => [{ address: "1.1.1.1", family: 4 }],
    dial: (ip, port, family) => {
      dials.push(`${ip}:${port}:${family}`);
      return connect(address.port, "127.0.0.1");
    },
  });
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(proxy.port, "127.0.0.1");
      socket.once("error", reject);
      socket.once("connect", () => socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
      let received = "";
      socket.on("data", (data) => {
        received += data.toString();
        if (received.includes("200 Connection Established")) socket.write("ping");
        if (received.includes("reply:ping")) { resolve(received); socket.destroy(); }
      });
    });
    assert.match(reply, /reply:ping/);
    assert.deepEqual(dials, ["1.1.1.1:443:4"]);
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  }
});

test("route interceptor aborts unapproved POST before fetch and uses zero redirects for approved POST", async () => {
  const mainFrame = {};
  let handler: ((route: Route) => Promise<void>) | undefined;
  const context = { async route(_pattern: string, callback: (route: Route) => Promise<void>) { handler = callback; } } as unknown as BrowserContext;
  const page = { mainFrame: () => mainFrame } as unknown as Page;
  const policy = new InteractiveNetworkPolicy(origins, "public", "https://example.com/start");
  policy.enterSupervised();
  await installInteractiveNetworkPolicy(context, page, policy, async () => undefined);
  assert.ok(handler);

  const calls: string[] = [];
  function route(url: string, status = 200): Route {
    return {
      request: () => ({ url: () => url, method: () => "POST", resourceType: () => "fetch", frame: () => mainFrame }),
      abort: async () => { calls.push("abort"); },
      fetch: async (options: { maxRedirects: number }) => {
        calls.push(`fetch:${options.maxRedirects}`);
        return { status: () => status, headers: () => status === 302 ? { location: "https://example.com/done" } : {}, dispose: async () => undefined };
      },
      fulfill: async () => { calls.push("fulfill"); },
    } as unknown as Route;
  }

  await handler(route("https://example.com/send"));
  assert.deepEqual(calls, ["abort"]);
  policy.approveSubmission({ method: "POST", url: "https://example.com/send" });
  await handler(route("https://example.com/send", 302));
  assert.deepEqual(calls, ["abort", "fetch:0", "abort"]);
  assert.equal(policy.submissionResult(), "outcome_unknown");
  await handler(route("https://example.com/send"));
  assert.deepEqual(calls, ["abort", "fetch:0", "abort", "abort"]);
});
