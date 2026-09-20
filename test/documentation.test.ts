import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function contents(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("README presents the public project without overstating its authority", async () => {
  const readme = await contents("../README.md");
  assert.match(readme, /docs\/assets\/jev-guard-banner\.svg/);
  assert.match(readme, /raniellimontagna\/jev-guard-mcp\/actions\/workflows\/ci\.yml/);
  assert.match(readme, /browser-only/i);
  assert.match(readme, /Resumo em português/i);
  assert.match(readme, /```mermaid/);
  assert.match(readme, /jev_guard_preview/);
  assert.match(readme, /jev_guard_execute/);
  assert.match(readme, /jev_guard_cancel/);
  assert.match(readme, /scripts\/run-from-keychain\.sh/);
  assert.match(readme, /TYPESAFE_API_KEY/);
  assert.match(readme, /human approval/i);
  assert.match(readme, /experimental/i);
  assert.doesNotMatch(readme, /não foi publicado|not published/i);
});

test("repository-owned banner is accessible and self-contained", async () => {
  const banner = await contents("../docs/assets/jev-guard-banner.svg");
  assert.match(banner, /<svg[^>]+role="img"/);
  assert.match(banner, /<title>Jev Guard MCP<\/title>/);
  assert.match(banner, /observe.*choose.*approve.*navigate/is);
  assert.doesNotMatch(banner, /<(?:image|use)[^>]+(?:href|xlink:href)="https?:\/\//i);
  assert.doesNotMatch(banner, /<script/i);
});

test("architecture documents code-owned policy and data sent to TypeSafe", async () => {
  const architecture = await contents("../docs/architecture.md");
  assert.match(architecture, /Codex.*planeja/is);
  assert.match(architecture, /Jev.*escolhe/is);
  assert.match(architecture, /Playwright.*executa/is);
  assert.match(architecture, /TypeSafe.*texto redigido/is);
  assert.match(architecture, /query strings.*não/is);
});

test("threat model records prohibited actions and residual risks", async () => {
  const threatModel = await contents("../docs/threat-model.md");
  assert.match(threatModel, /DNS rebinding/i);
  assert.match(threatModel, /efeito colateral.*GET/i);
  assert.match(threatModel, /downloads/i);
  assert.match(threatModel, /rede privada/i);
  assert.match(threatModel, /confiança mínima.*0[,.]80/i);
});
