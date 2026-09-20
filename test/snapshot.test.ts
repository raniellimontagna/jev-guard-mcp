import assert from "node:assert/strict";
import test from "node:test";

import type { RawLink, RawPageSnapshot } from "../src/contracts.js";
import { buildSnapshot } from "../src/browser/snapshot.js";

function rawSnapshot(links: RawLink[]): RawPageSnapshot {
  return {
    url: "https://example.com/start?session=secret#top",
    title: "  Example   user@example.com ",
    text: `Welcome user@example.com ${"word ".repeat(800)}`,
    links,
  };
}

test("keeps only visible, safe and uniquely identified candidates", () => {
  const snapshot = buildSnapshot(
    rawSnapshot([
      { href: "/docs", label: "  Product   docs ", visible: true, download: false },
      { href: "/hidden", label: "Hidden", visible: false, download: false },
      { href: "/search?q=x", label: "Search", visible: true, download: false },
      { href: "https://other.example/page", label: "Other", visible: true, download: false },
      { href: "/logout", label: "Logout", visible: true, download: false },
      { href: "/file", label: "File", visible: true, download: true },
      { href: "/empty", label: "   ", visible: true, download: false },
    ]),
  );

  assert.equal(snapshot.publicUrl, "https://example.com/start");
  assert.equal(snapshot.title, "Example [REDACTED_EMAIL]");
  assert.equal(snapshot.text.length, 3_000);
  assert.deepEqual(snapshot.candidates.map(({ id, label, url, publicUrl }) => ({ id, label, url, publicUrl })), [
    {
      id: "link_0",
      label: "Product docs",
      url: "https://example.com/docs",
      publicUrl: "https://example.com/docs",
    },
  ]);
});

test("caps candidates at 80 and produces stable fingerprints", () => {
  const links = Array.from({ length: 90 }, (_, index) => ({
    href: `/docs/${index}`,
    label: `Document ${index}`,
    visible: true,
    download: false,
  }));

  const first = buildSnapshot(rawSnapshot(links));
  const second = buildSnapshot(rawSnapshot(links));

  assert.equal(first.candidates.length, 80);
  assert.deepEqual(first.candidates, second.candidates);
  assert.match(first.candidates[0]?.fingerprint ?? "", /^[a-f0-9]{64}$/);
});

test("deduplicates identical destinations", () => {
  const snapshot = buildSnapshot(
    rawSnapshot([
      { href: "/docs", label: "Docs one", visible: true, download: false },
      { href: "/docs", label: "Docs two", visible: true, download: false },
    ]),
  );

  assert.equal(snapshot.candidates.length, 1);
});
