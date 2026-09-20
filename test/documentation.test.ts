import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function contents(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("README states setup, safety boundary and non-registration status", async () => {
  const readme = await contents("../README.md");
  assert.match(readme, /browser-only/i);
  assert.match(readme, /scripts\/run-from-keychain\.sh/);
  assert.match(readme, /TYPESAFE_API_KEY/);
  assert.match(readme, /não (digita|envia formulários)/i);
  assert.match(readme, /não está registrado globalmente/i);
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
