import assert from "node:assert/strict";
import test from "node:test";

import { publicUrl, redactText } from "../src/security/redaction.js";

test("redacts e-mails, phone numbers and bearer-like tokens", () => {
  assert.equal(
    redactText("Contact me@example.com or +55 51 99999-0000 token abcdefghijklmnopqrstuvwxyz123"),
    "Contact [REDACTED_EMAIL] or [REDACTED_PHONE] token [REDACTED_TOKEN]",
  );
});

test("normalizes whitespace and applies a length cap", () => {
  assert.equal(redactText("  one\n\t two   three  "), "one two three");
  assert.equal(redactText("x".repeat(20), 8), "xxxxxxxx");
});

test("removes query strings, fragments and credentials from public URLs", () => {
  assert.equal(
    publicUrl("https://user:secret@example.com/path?q=secret#part"),
    "https://example.com/path",
  );
});

test("removes query strings from absolute URLs embedded in text", () => {
  assert.equal(
    redactText("Open https://example.com/report?token=secret#section now"),
    "Open https://example.com/report now",
  );
  assert.equal(
    redactText("Open /report?token=short and //cdn.example/file?key=short"),
    "Open /report and //cdn.example/file",
  );
  assert.equal(
    redactText("Open report?token=short, ?session=secret and //cdn.example?key=short"),
    "Open report and //cdn.example",
  );
});
