const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?:\+?\d[\d\s().-]{8,}\d)/g;
const tokenPattern = /\b[A-Za-z0-9_-]{24,}\b/g;
const absoluteUrlPattern = /https?:\/\/[^\s<>"']+/gi;
const schemeRelativeUrlPattern = /(?<!:)\/\/[A-Z0-9.-]+(?::\d+)?\/[^\s<>"']+/gi;
const rootRelativeUrlPattern = /(^|[\s([{"'])(\/(?!\/)[^\s<>"']*\?[^\s<>"']*)/g;
const remainingQueryPattern = /\?[^\s<>"']+/g;

function publicRelativeUrl(raw: string): string {
  const url = new URL(raw, "https://redaction.invalid");
  return url.pathname;
}

function publicSchemeRelativeUrl(raw: string): string {
  const url = new URL(`https:${raw}`);
  return `//${url.host}${url.pathname}`;
}

export function redactText(value: string, maxLength = 3_000): string {
  return value
    .normalize("NFKC")
    .replace(absoluteUrlPattern, (url) => {
      try {
        return publicUrl(url);
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(schemeRelativeUrlPattern, (url) => {
      try {
        return publicSchemeRelativeUrl(url);
      } catch {
        return "[REDACTED_URL]";
      }
    })
    .replace(rootRelativeUrlPattern, (_match, prefix: string, url: string) => {
      try {
        return `${prefix}${publicRelativeUrl(url)}`;
      } catch {
        return `${prefix}[REDACTED_URL]`;
      }
    })
    .replace(remainingQueryPattern, "")
    .replace(emailPattern, "[REDACTED_EMAIL]")
    .replace(phonePattern, "[REDACTED_PHONE]")
    .replace(tokenPattern, "[REDACTED_TOKEN]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function publicUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}
