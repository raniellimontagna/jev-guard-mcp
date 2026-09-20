import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPublicHostname,
  candidateUrl,
  validateStartUrl,
} from "../src/security/url-policy.js";

test("accepts a public HTTPS start URL", () => {
  assert.equal(validateStartUrl("https://example.com/docs").href, "https://example.com/docs");
});

test("rejects unsafe start URLs", () => {
  assert.throws(() => validateStartUrl("https://localhost/private"), /public hostname/);
  assert.throws(() => validateStartUrl("https://user:pass@example.com/"), /credentials/);
  assert.throws(() => validateStartUrl("http://example.com/"), /HTTPS/);
});

test("keeps only same-origin query-free low-risk link candidates", () => {
  const base = new URL("https://example.com/start");

  assert.equal(candidateUrl(base, "/docs", false)?.href, "https://example.com/docs");
  assert.equal(candidateUrl(base, "https://example.com/search?q=x", false), null);
  assert.equal(candidateUrl(base, "https://other.example/path", false), null);
  assert.equal(candidateUrl(base, "/logout", false), null);
  assert.equal(candidateUrl(base, "/report.pdf", true), null);
});

test("rejects hostnames resolving to private addresses", async () => {
  await assert.rejects(
    assertPublicHostname("example.test", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    /non-public address/,
  );
});

test("accepts hostnames when every resolved address is public", async () => {
  await assert.doesNotReject(
    assertPublicHostname("example.test", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]),
  );
});
