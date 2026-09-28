import { createHash } from "node:crypto";

import { publicUrl, redactText } from "../security/redaction.js";
import { validateStartUrl } from "../security/url-policy.js";
import type {
  ActionCandidate,
  ActionKind,
  FormEvidence,
  InteractiveSnapshot,
  RawInteractiveElement,
  RawInteractivePage,
  SitePolicy,
} from "./contracts.js";

const MAX_CANDIDATES = 80;
const RISKY_PATH = /(?:^|[\/_\-.])(logout|signout|unsubscribe|delete|remove|destroy|checkout|purchase|payment|download|export|oauth|authorize|login|signin|signup|register|confirm)(?:$|[\/_\-.])/i;
const CREDENTIAL_KEY = /(?:^|_)(?:password|passwd|passcode|otp|totp|secret|token|api_key|pin|cookie|session)(?:_|$)/i;
const SAFE_HIDDEN_FORM_TOKEN = /^(?:csrf(?:_token)?|_csrf|_token|authenticity_token|__requestverificationtoken)$/i;
const FILLABLE_TYPE = /^(text|email|tel|search|url|number|textarea)$/i;

function decodedPath(pathname: string): string | undefined {
  let current = pathname;
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const next = decodeURIComponent(current);
      if (next === current) return next.normalize("NFKC");
      current = next;
    }
  } catch {
    return undefined;
  }
  return /%[0-9a-f]{2}/i.test(current) ? undefined : current.normalize("NFKC");
}

export function safeInteractivePath(pathname: string): boolean {
  const path = decodedPath(pathname);
  return !!path && !RISKY_PATH.test(path);
}

export function safeValueKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{0,49}$/.test(key) && !CREDENTIAL_KEY.test(key);
}

function sameSiteUrl(raw: string, source: URL, siteOrigin: string): string | undefined {
  try {
    const url = validateStartUrl(new URL(raw, source).href);
    if (url.origin !== siteOrigin || !safeInteractivePath(url.pathname)) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function validForm(form: FormEvidence | undefined, source: URL, siteOrigin: string): FormEvidence | undefined {
  if (!form || form.method.toUpperCase() !== "POST" || form.hasFileInput
    || form.hasSubmitterOverrides || (form.submitterName ?? "") !== ""
    || !["", "_self"].includes(form.target ?? "")
    || (form.enctype ?? "application/x-www-form-urlencoded") !== "application/x-www-form-urlencoded"
    || form.fields.length > 100 || form.fields.some(({ name, value }) => name.length > 100 || value.length > 4096)) return undefined;
  if (form.fields.some((field) =>
    (CREDENTIAL_KEY.test(field.name) && !(field.hidden && SAFE_HIDDEN_FORM_TOKEN.test(field.name)))
    || /^(password|file)$/i.test(field.type ?? ""))) return undefined;
  const action = sameSiteUrl(form.action, source, siteOrigin);
  if (!action) return undefined;
  return {
    action,
    method: "POST",
    hasFileInput: false,
    enctype: "application/x-www-form-urlencoded",
    target: "_self",
    submitterName: "",
    hasSubmitterOverrides: false,
    fields: form.fields.map((field) => ({ ...field })),
  };
}

function fingerprint(sourceUrl: string, candidate: Omit<ActionCandidate, "id" | "fingerprint">): string {
  return createHash("sha256")
    .update(JSON.stringify([
      sourceUrl,
      candidate.kind,
      candidate.domIndex,
      candidate.label,
      candidate.destination,
      candidate.valueKey ?? null,
      candidate.direction ?? null,
      candidate.fieldName ?? null,
      candidate.fieldType ?? null,
      candidate.form?.fields.map(({ name, value, hidden, type }) => [name, value, hidden, type ?? null]) ?? null,
      candidate.form?.enctype ?? null,
      candidate.form?.target ?? null,
    ]))
    .digest("hex");
}

export function buildInteractiveSnapshot(
  raw: RawInteractivePage,
  policy: SitePolicy,
  valueKeys: readonly string[] = [],
): InteractiveSnapshot {
  const source = validateStartUrl(raw.url);
  const siteOrigin = validateStartUrl(policy.siteOrigin).origin;
  if (source.origin !== siteOrigin) throw new Error("Page left the allowed site origin");

  const candidates: ActionCandidate[] = [];
  const add = (element: RawInteractiveElement, kind: ActionKind, destination: string, valueKey?: string, form?: FormEvidence, direction?: "up" | "down") => {
    if (candidates.length >= MAX_CANDIDATES) return;
    const base = {
      kind,
      domIndex: element.domIndex,
      label: redactText(element.label, 160),
      destination,
      ...(valueKey === undefined ? {} : { valueKey }),
      ...(direction === undefined ? {} : { direction }),
      ...(kind === "fill" || kind === "select" ? { fieldName: element.name, fieldType: element.fieldType } : {}),
      ...(form === undefined ? {} : { form }),
    };
    if (!base.label) return;
    candidates.push({ ...base, id: `action_${candidates.length}`, fingerprint: fingerprint(source.href, base) });
  };

  for (const element of raw.elements) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (!element.visible || !element.enabled) continue;
    if (element.kind === "link" && element.href && !element.download && ["", "_self"].includes(element.target ?? "")) {
      const target = sameSiteUrl(element.href, source, siteOrigin);
      if (target) add(element, "navigate", target);
    } else if (element.kind === "button" && element.buttonEffect) {
      add(element, "toggle", source.href);
    } else if ((element.kind === "field" || element.kind === "select") && element.name
      && (element.kind === "select" || FILLABLE_TYPE.test(element.fieldType ?? "")) && !CREDENTIAL_KEY.test(element.name)) {
      for (const key of valueKeys) {
        if (safeValueKey(key)) add(element, element.kind === "select" ? "select" : "fill", source.href, key);
      }
    } else if (element.kind === "submit") {
      const form = validForm(element.form, source, siteOrigin);
      if (form) add(element, "submit", form.action, undefined, form);
    }
  }

  if (raw.viewport?.canScrollUp) {
    add({ domIndex: -1, kind: "button", label: "Scroll up", visible: true, enabled: true }, "scroll", source.href, undefined, undefined, "up");
  }
  if (raw.viewport?.canScrollDown) {
    add({ domIndex: -2, kind: "button", label: "Scroll down", visible: true, enabled: true }, "scroll", source.href, undefined, undefined, "down");
  }
  if (raw.canWait) {
    add({ domIndex: -3, kind: "button", label: "Wait for page update", visible: true, enabled: true }, "wait", source.href);
  }

  return {
    sourceUrl: source.href,
    publicUrl: publicUrl(source.href),
    title: redactText(raw.title, 200),
    modelText: redactText(raw.text, 3_000),
    modelActions: candidates.map(({ id, kind, label, destination, valueKey, direction }) => ({
      id,
      kind,
      label,
      destination: publicUrl(destination),
      ...(valueKey === undefined ? {} : { valueKey }),
      ...(direction === undefined ? {} : { direction }),
    })),
    candidates,
  };
}
