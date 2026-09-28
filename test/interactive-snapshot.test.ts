import assert from "node:assert/strict";
import test from "node:test";

import { buildInteractiveSnapshot } from "../src/interactive/snapshot.js";
import type { RawInteractivePage } from "../src/interactive/contracts.js";

const page: RawInteractivePage = {
  url: "https://example.com/start?session=PRIVATE_QUERY",
  title: "Customer portal",
  text: "Hello client@example.com. Choose an action.",
  elements: [
    { domIndex: 0, kind: "link", label: "Read details", visible: true, enabled: true, href: "/details?tab=overview" },
    { domIndex: 1, kind: "button", label: "Show details", visible: true, enabled: true, buttonEffect: "disclosure" },
    { domIndex: 2, kind: "field", label: "Email", visible: true, enabled: true, name: "email", fieldType: "email" },
    { domIndex: 3, kind: "field", label: "Password", visible: true, enabled: true, name: "password", fieldType: "password" },
    {
      domIndex: 4,
      kind: "submit",
      label: "Send inquiry",
      visible: true,
      enabled: true,
      form: {
        action: "https://example.com/inquiries",
        method: "POST",
        hasFileInput: false,
        fields: [
          { name: "email", value: "client@example.com", hidden: false },
          { name: "csrf", value: "PRIVATE_CSRF", hidden: true },
        ],
      },
    },
    { domIndex: 5, kind: "link", label: "Other site", visible: true, enabled: true, href: "https://other.example/" },
    { domIndex: 6, kind: "link", label: "Delete", visible: true, enabled: true, href: "/delete" },
    { domIndex: 7, kind: "link", label: "Download", visible: true, enabled: true, href: "/file", download: true },
    { domIndex: 8, kind: "link", label: "Hidden", visible: false, enabled: true, href: "/hidden" },
    { domIndex: 9, kind: "button", label: "Unknown effect", visible: true, enabled: true },
  ],
};

test("builds bounded actions without exposing private values to Jev", () => {
  const snapshot = buildInteractiveSnapshot(page, { siteOrigin: "https://example.com" }, ["contact_email"]);
  assert.deepEqual(snapshot.candidates.map(({ kind }) => kind), ["navigate", "toggle", "fill", "submit"]);
  assert.deepEqual(snapshot.candidates.map(({ id }) => id), ["action_0", "action_1", "action_2", "action_3"]);
  assert.equal(snapshot.candidates[0]?.destination, "https://example.com/details?tab=overview");
  assert.equal(snapshot.candidates[2]?.valueKey, "contact_email");
  assert.match(snapshot.modelText, /\[REDACTED_EMAIL\]/);
  assert.doesNotMatch(JSON.stringify({ text: snapshot.modelText, actions: snapshot.modelActions }), /PRIVATE_QUERY|PRIVATE_CSRF|client@example\.com/);
  assert.equal(snapshot.candidates[3]?.form?.fields[0]?.value, "client@example.com");
  assert.equal(snapshot.candidates[3]?.form?.fields[1]?.hidden, true);
});

test("changes a submit fingerprint if a hidden field changes", () => {
  const first = buildInteractiveSnapshot(page, { siteOrigin: "https://example.com" }, ["contact_email"]);
  const changed: RawInteractivePage = {
    ...page,
    elements: page.elements.map((element) => element.kind === "submit" && element.form
      ? { ...element, form: { ...element.form, fields: element.form.fields.map((field) => field.name === "csrf" ? { ...field, value: "OTHER_CSRF" } : field) } }
      : element),
  };
  const second = buildInteractiveSnapshot(changed, { siteOrigin: "https://example.com" }, ["contact_email"]);
  assert.notEqual(first.candidates[3]?.fingerprint, second.candidates[3]?.fingerprint);
});

test("does not offer encoded destructive links or credential-looking value keys", () => {
  const changed: RawInteractivePage = {
    ...page,
    elements: [
      { domIndex: 0, kind: "link", label: "Open", visible: true, enabled: true, href: "/%2564elete" },
      { domIndex: 1, kind: "field", label: "Email", visible: true, enabled: true, name: "email", fieldType: "email" },
    ],
  };
  const snapshot = buildInteractiveSnapshot(changed, { siteOrigin: "https://example.com" }, ["client@example.com", "password", "contact_email"]);
  assert.deepEqual(snapshot.candidates.map(({ kind, valueKey }) => [kind, valueKey]), [["fill", "contact_email"]]);
  assert.doesNotMatch(JSON.stringify(snapshot.modelActions), /client@example\.com|password/);
});

test("changes a fill fingerprint when its field identity changes", () => {
  const raw: RawInteractivePage = {
    ...page,
    elements: [{ domIndex: 0, kind: "field", label: "Contact", visible: true, enabled: true, name: "email", fieldType: "email" }],
  };
  const first = buildInteractiveSnapshot(raw, { siteOrigin: "https://example.com" }, ["contact_email"]);
  const second = buildInteractiveSnapshot({ ...raw, elements: [{ ...raw.elements[0]!, name: "account" }] }, { siteOrigin: "https://example.com" }, ["contact_email"]);
  assert.notEqual(first.candidates[0]?.fingerprint, second.candidates[0]?.fingerprint);
});

test("offers bounded scroll and wait actions only when the observer reports them", () => {
  const snapshot = buildInteractiveSnapshot({
    ...page,
    elements: [],
    viewport: { canScrollUp: false, canScrollDown: true },
    canWait: true,
  }, { siteOrigin: "https://example.com" });
  assert.deepEqual(snapshot.candidates.map(({ kind, direction }) => [kind, direction]), [
    ["scroll", "down"],
    ["wait", undefined],
  ]);
});

test("does not offer a form that would submit credentials", () => {
  const raw: RawInteractivePage = {
    ...page,
    elements: [{
      domIndex: 0,
      kind: "submit",
      label: "Sign in",
      visible: true,
      enabled: true,
      form: {
        action: "https://example.com/session",
        method: "POST",
        hasFileInput: false,
        fields: [{ name: "password", value: "PRIVATE_PASSWORD", hidden: false, type: "password" }],
      },
    }],
  };
  const snapshot = buildInteractiveSnapshot(raw, { siteOrigin: "https://example.com" });
  assert.deepEqual(snapshot.candidates, []);
});
