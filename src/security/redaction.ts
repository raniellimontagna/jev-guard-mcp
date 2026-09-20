const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?:\+?\d[\d\s().-]{8,}\d)/g;
const tokenPattern = /\b[A-Za-z0-9_-]{24,}\b/g;

export function redactText(value: string, maxLength = 3_000): string {
  return value
    .normalize("NFKC")
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
