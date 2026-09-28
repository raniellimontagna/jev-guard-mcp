# Threat model: guarda público original e modo supervisionado

## Ativos protegidos

- credencial TypeSafe;
- perfil, cookies e sessões autenticadas do usuário;
- rede local e serviços de metadata;
- dados visíveis, query strings, inputs e screenshots;
- autoridade para executar ações externas.

## Ações proibidas no guarda público original

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

## Modo supervisionado: controles adicionais

O modo `jev_browser_*` tem seu próprio contexto Chrome efêmero e não herda cookies, armazenamento ou senha do perfil pessoal. O usuário pode fazer login manualmente; a página autenticada só passa ao Jev após opt-in explícito para compartilhar texto visível redigido com TypeSafe. A redação é parcial e não garante remoção de todos os dados privados. Valores fornecidos via MCP ficam apenas na memória da sessão e são removidos das representações destinadas ao modelo, mas campos não controlados podem conter informações privadas desconhecidas.

Cada ação proposta mostra origem, rótulo, destino, confiança e valor ou campos relevantes. O cliente MCP confiável deve obter aprovação humana antes de transmitir o token ao executor; o servidor não comprova essa aprovação. O token é usado uma vez e o estado do DOM e do formulário é revalidado antes da ação. O proxy de saída fixa a conexão ao IP público aprovado e limita hosts/portas às origens declaradas, inclusive para redirects seguidos pelo Chrome durante login. O interceptor Playwright bloqueia métodos não aprovados, documentos em subframes e novos requests após preenchimento. Um POST aprovado exige método, destino, corpo e documento principal exatos, com uma única passagem.

| Risco | Limite e consequência |
|---|---|
| Cliente MCP sem aprovação real | Posse do token basta para executar; a integração deve implementar a confirmação humana. |
| Texto autenticado sensível | Redação imperfeita; escolher páginas e tarefas adequadas ao compartilhamento com TypeSafe. |
| JavaScript da página | Pode alterar conteúdo, disparar GETs, induzir Jev ou tentar ações. O interceptor bloqueia mutações não aprovadas, mas não prova que GETs são sem efeito. |
| Login manual | POSTs nas origens de login aprovadas são possíveis enquanto o usuário controla o Chrome; não usar origens amplas desnecessárias. |
| Valor em handler de input | A trava começa antes do preenchimento e barra novas requisições; scripts podem modificar DOM local, e requisições já iniciadas antes da trava podem terminar. |
| Formulário com lógica JavaScript | O envio nativo ignora `onsubmit`; sites que dependem dessa lógica ou de endpoint dinâmico não são suportados. |
| Formulário com dados não revisados | A prévia lista campos não ocultos e sinaliza ocultos. O fingerprint e o corpo exato previnem mudanças silenciosas, mas o usuário deve compreender o significado dos campos. |
| POST com resposta ambígua | Uma requisição pode ter chegado ao servidor sem confirmação; reportar `outcome_unknown` e investigar externamente, sem retry. Resposta 2xx não prova sucesso de negócio. |
| Valor passado como argumento | Chaves com nomes de credenciais são rejeitadas; o sistema não consegue reconhecer semanticamente todos os segredos colocados sob nomes inocentes. |

## Fora de escopo

O guarda público original continua sem contas autenticadas ou formulários. No modo supervisionado, intranet, localhost, controle do Mac inteiro, downloads, uploads, WebSockets, popups, OAuth, compras, pagamentos, exclusões e envio de formulários geridos apenas por JavaScript permanecem fora de escopo. Testes automatizados usam somente páginas HTTPS sintéticas locais por meio de proxy de teste; um piloto em site real exige política de origem revisada e aprovação de cada ação.
