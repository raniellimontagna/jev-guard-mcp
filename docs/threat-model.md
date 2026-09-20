# Threat model

## Ativos protegidos

- credencial TypeSafe;
- perfil, cookies e sessões autenticadas do usuário;
- rede local e serviços de metadata;
- dados visíveis, query strings, inputs e screenshots;
- autoridade para executar ações externas.

## Ações proibidas no piloto

O sistema não digita, não envia formulários, não clica em botões, não executa JavaScript fornecido pelo modelo, não faz uploads ou downloads e não acessa aplicativos nativos. Login, logout, OAuth, compras, pagamentos, exclusões, confirmações, exportações e inscrições são removidos do espaço de ações.

## Controles

The trusted MCP client is responsible for showing source, label and destination and obtaining explicit human approval before execute. Possession of a preview token is technical authorization; the server cannot independently attest human approval. Um cliente comprometido ou autônomo com o token consegue executar sem aprovação humana; a integração deve preservar esse limite de confiança.

| Ameaça | Controle |
|---|---|
| SSRF e rede privada | HTTPS obrigatório, bloqueio sintático, resolução DNS pública e verificação de cada request Playwright |
| Roubo de sessão | contexto novo, sem perfil Chrome, cookies ou storage do usuário |
| Segredo herdado pelo Chrome | processo filho recebe somente uma allowlist mínima de variáveis operacionais, sem tokens da aplicação |
| Ação inventada pelo modelo | Jev só pode escolher IDs definidos pelo código |
| Decisão ambígua | confiança mínima `0.80`; abaixo disso não há token |
| Página alterada | URL, ID, rótulo, destino e fingerprint revalidados |
| Double action | token consumido antes da navegação |
| Click handler hostil | navegação direta com `page.goto()` |
| Redirect ou GET não aprovado | URL principal exata; requests via fetch sem seguir redirects, aborto de respostas 3xx e pós-condição exata |
| Navegação em iframe | documentos de subframes bloqueados antes da rede |
| Exaustão de browsers | reserva de capacidade antes da abertura, mantida até o fechamento, incluindo execução consumida |
| Shutdown com trabalho pendente | fecha browsers ativos e aguarda aberturas iniciadas; decisões do modelo não impedem fechamento |
| Erro de dependência com segredo | códigos/mensagens MCP constantes, fallback genérico, sem URL, path ou call log |
| Script ou WebSocket hostil | JavaScript da página desativado e WebSockets bloqueados no contexto |
| Vazamento ao provedor | redaction e limites; sem screenshots, HTML, inputs ou query strings |
| Persistência acidental | sessão e token somente em memória; sem logs de conteúdo |
| Resposta TypeSafe inconsistente | modelo fixado, uso numérico validado e distribuição de probabilidades conferida |

## Riscos residuais

- **DNS rebinding:** resolver o hostname antes de uma request reduz SSRF, mas o endereço efetivamente usado pelo fetch do Playwright não é fixado pelo policy engine. Um proxy de saída com bloqueio de CIDRs seria necessário para eliminar essa lacuna.
- **Efeito colateral em GET:** servidores incorretos podem alterar estado em uma navegação GET. Perfil isolado, ausência de autenticação, bloqueio de query strings e denylist reduzem a consequência, mas não provam idempotência remota.
- **Conteúdo adversarial:** texto da página pode influenciar Jev. O executor continua limitado a candidatos seguros, mas uma página pode induzir a escolha do link errado.
- **Redaction imperfeita:** padrões desconhecidos de PII podem permanecer no texto visível. O piloto não deve ser usado em páginas privadas.
- **CDNs públicas:** subrecursos públicos cross-origin são permitidos após resolução; isso amplia a superfície de tracking da página pública.
- **Disponibilidade:** desativar JavaScript e bloquear todos os redirects HTTP, candidatos com query strings, frames e controles complexos reduz cobertura intencionalmente.

## Fora de escopo

Contas autenticadas, intranet, localhost, whole-Mac computer use, digitação, formulários, downloads, uploads e transações permanecem fora do piloto.
