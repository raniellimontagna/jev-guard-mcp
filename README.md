# Jev Guard MCP

Piloto **browser-only** que conecta Codex, Jev/TypeSafe e Playwright sem entregar o controle do navegador ao modelo.

O Codex planeja; Jev escolhe uma opção criada pelo código; a policy engine valida; Playwright observa ou executa exatamente uma navegação. O servidor não digita, não envia formulários, não clica em botões, não usa o perfil Chrome pessoal e não faz upload ou download.

## Estado

Este piloto **não está registrado globalmente** no Codex e não foi publicado. Ele vive na branch `codex/jev-guard-pilot` para validação local.

## Boundary de segurança

- somente páginas públicas `https:`;
- contexto Chrome novo e sem sessão autenticada;
- ambiente do processo Chrome limitado a variáveis operacionais não secretas;
- JavaScript da página e WebSockets desativados;
- apenas links visíveis, same-origin, sem query string e sem termos de risco;
- bloqueio de localhost, endereços privados e destinos resolvidos para rede privada;
- no máximo 80 candidatos e 3 prévias pendentes;
- confiança mínima Jev de `0.80`;
- token em memória, descartável e válido por 120 segundos;
- reobservação exata antes de navegar;
- execução via `page.goto()`, sem event handlers da página;
- nenhum screenshot, HTML, valor de input, cookie ou local storage é coletado.

Os riscos residuais estão em [docs/threat-model.md](docs/threat-model.md).

## Instalação e verificação

Requer Node.js 22+, Google Chrome e uma credencial TypeSafe disponível como `TYPESAFE_API_KEY` ou no macOS Keychain com service `typesafe-api-key`.

```bash
npm install --ignore-scripts
npm test
npm run typecheck
npm run build
```

O projeto nunca carrega `.env`. Para iniciar o MCP sem gravar o segredo em configuração:

```bash
./scripts/run-from-keychain.sh
```

## Ferramentas MCP

1. `jev_guard_preview` abre a página isolada e retorna a ação proposta, confiança e token.
2. O usuário confere origem, rótulo e destino.
3. `jev_guard_execute` consome o token e executa uma única navegação, ou `jev_guard_cancel` fecha a sessão.

O `execute` deve ser chamado somente após aprovação explícita da ação exata mostrada pela prévia.

## Smoke test público

A execução padrão apenas cria a prévia e depois cancela o token, fechando o browser:

```bash
npm run smoke:live
```

Para executar uma navegação pública única na Wikipedia:

```bash
npm run smoke:live -- --execute
```

O relatório omite o token e qualquer segredo.

## Registro futuro no Codex

Depois de uma revisão humana, o bloco candidato é:

```toml
[mcp_servers.jev_guard]
command = "/Users/raniellimontagna/Projetos/pessoal/jev-guard-mcp/scripts/run-from-keychain.sh"
```

Esse bloco é apenas documentação; esta implementação não altera `~/.codex/config.toml`.
