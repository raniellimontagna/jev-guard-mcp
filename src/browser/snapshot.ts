import { createHash } from "node:crypto";

import type { LinkCandidate, PageSnapshot, RawPageSnapshot } from "../contracts.js";
import { publicUrl, redactText } from "../security/redaction.js";
import { candidateUrl, validateStartUrl } from "../security/url-policy.js";

const MAX_CANDIDATES = 80;

function fingerprint(source: URL, candidate: URL, label: string): string {
  return createHash("sha256")
    .update(`${source.origin}${source.pathname}\0${candidate.href}\0${label}`)
    .digest("hex");
}

export function buildSnapshot(raw: RawPageSnapshot): PageSnapshot {
  const source = validateStartUrl(raw.url);
  const candidates: LinkCandidate[] = [];
  const seenDestinations = new Set<string>();

  for (const link of raw.links) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (!link.visible) continue;

    const target = candidateUrl(source, link.href, link.download);
    if (!target || seenDestinations.has(target.href)) continue;

    const label = redactText(link.label, 160);
    if (!label) continue;

    seenDestinations.add(target.href);
    candidates.push({
      id: `link_${candidates.length}`,
      label,
      url: target.href,
      publicUrl: publicUrl(target.href),
      fingerprint: fingerprint(source, target, label),
    });
  }

  return {
    sourceUrl: source.href,
    publicUrl: publicUrl(source.href),
    title: redactText(raw.title, 200),
    text: redactText(raw.text, 3_000),
    candidates,
  };
}
