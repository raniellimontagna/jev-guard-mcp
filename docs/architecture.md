# Arquitetura: guarda público original

## Responsabilidades

- **Codex planeja** o objetivo, decide quando pedir uma prévia e apresenta a ação ao usuário.
- **Playwright observa e executa** em um contexto Chrome efêmero sem perfil do usuário, com JavaScript da página e WebSockets desativados.
- **Jev escolhe** entre `done`, `blocked` e os IDs de links produzidos pelo código.
- **Policy engine decide** quais URLs podem virar candidatos e se a decisão ainda está fresca.

```text
Codex -> jev_guard_preview -> Playwright observa
                              |-> policy reduz os links
                              |-> TypeSafe/Jev escolhe um ID
Codex <- ação + confiança + token descartável

aprovação humana -> jev_guard_execute -> reobserva -> valida -> page.goto -> verifica origem -> fecha
```

## Dados enviados ao TypeSafe

O TypeSafe recebe somente texto redigido e limitado: objetivo, título, trecho visível, origem/caminho público e até 80 pares de rótulo/destino. Os destinos incluem URLs absolutas públicas de origem e caminho, após remover credenciais, query strings e fragmentos. E-mails, telefones e tokens longos são substituídos antes da requisição. Query strings não são enviadas, e valores de inputs não são lidos.

Não são enviados screenshots, HTML, cookies, local storage, seletores, coordenadas ou dados do perfil Chrome.

## Preview e execução

The trusted MCP client is responsible for showing source, label and destination and obtaining explicit human approval before execute. Possession of a preview token is technical authorization; the server cannot independently attest human approval. O fluxo permanece preview → aprovação humana → execute, e o cliente deve manter o token privado.

A prévia mantém o browser aberto por até 120 segundos e armazena em memória o snapshot exato, candidato, confiança e token aleatório. Na execução, o token é removido antes de qualquer efeito. O sistema reextrai a página e compara URL de origem, ID, rótulo, destino e fingerprint. Qualquer diferença fecha o browser e falha como estado stale.

O executor navega para a URL aprovada usando `page.goto()`. Ele não dispara o click handler fornecido pela página. A rota principal só chega à rede quando coincide exatamente com a URL aprovada. Cada request HTTPS valida o hostname e usa `route.fetch({ maxRedirects: 0 })`; respostas 3xx são abortadas e somente respostas sem redirect chegam ao browser por `route.fulfill`. Isso também bloqueia redirects de subrecursos. Documentos de subframes são abortados antes de qualquer acesso à rede. A URL final continua sujeita à pós-condição exata. A URL inicial pode conter query; candidatos de navegação não podem.

O SessionStore reserva capacidade antes de abrir browser ou chamar o modelo. A reserva acompanha abertura, decisão pendente, token armazenado e execução consumida; fechamento, expiração, cancelamento, erro e decisões terminais liberam a reserva. Shutdown rejeita novo trabalho, fecha reservas com browsers ativos e aguarda aberturas já iniciadas para fechá-las, sem depender de uma resposta do modelo. Erros MCP usam uma allowlist de códigos e mensagens constantes e um fallback genérico, sem repassar mensagens de dependências.

## Dependências e credenciais

As dependências diretas e o modelo `jev-1.13.0` são fixados. O SDK TypeSafe usa base URL constante, zero retries automáticos, timeout de 10 segundos e logging desligado. O cliente rejeita respostas que aleguem outro modelo ou tragam métricas de uso inválidas. A chave vem somente do ambiente; `scripts/run-from-keychain.sh` pode carregá-la do Keychain sem imprimi-la.

## Modo supervisionado `jev_browser_*`

Este modo é independente dos três `jev_guard_*`. `InteractiveSessionService` gerencia no máximo duas sessões isoladas por 15 minutos, 20 ações e 25 decisões do Jev. Cada decisão gera apenas um candidato e um token de 120 segundos. `preview` não executa o candidato; `execute` consome o token, reobserva URL, elemento e fingerprint e realiza uma única ação. Erro fatal, cancelamento ou término fecha o Chrome e apaga os valores em memória. O cliente MCP confiável precisa obter aprovação humana por ação.

```text
Codex -> jev_browser_open -> Chrome isolado -> URL inicial
       -> jev_browser_preview -> DOM limitado -> IDs de ações -> TypeSafe/Jev
Codex <- origem + ação + confiança + valor/campos relevantes + token
aprovação humana -> jev_browser_execute -> reobservação -> ação única
```

O observador extrai links, controles visíveis, campos e formulários; o construtor filtra ações para a origem declarada e até 80 candidatos. Jev recebe objetivo, texto limitado e redigido, rótulos, destinos públicos e chaves semânticas dos valores. O transporte TypeSafe não recebe os valores, campos ocultos, cookies, HTML ou seletores. Após preenchimento, valores conhecidos também são removidos do texto que pode voltar a Jev. Essa redação não garante sigilo de todo conteúdo privado: o modo autenticado exige opt-in explícito antes de enviar texto visível ao TypeSafe.

O login autenticado acontece manualmente em janela Chrome headed e origem de autenticação aprovada. Enquanto o login está pendente, nenhuma página é enviada a Jev. A passagem ao modo supervisionado exige retorno à origem principal e ausência de campo de senha visível. O estado autenticado se perde ao fechar a sessão.

O Chrome supervisionado usa JavaScript, bloqueia service workers, WebSockets, downloads e popups e usa um proxy CONNECT local. O proxy aceita somente origens HTTPS listadas, resolve todos os endereços, rejeita IPs privados e conecta ao IP público verificado. O interceptor Playwright aplica fases: abertura, login manual, leitura supervisionada, bloqueio após valor e um único POST aprovado. GET/HEAD supervisionados podem buscar recursos da origem principal e de `resourceOrigins`; documentos principais exigem URL exata. Redirecionamentos supervisionados são abortados.

Antes de preencher ou selecionar, a rede é travada; isso inclui requisições disparadas por handlers de input. O formulário aceito é HTML nativo com método POST, destino HTTPS da origem principal, enctype `application/x-www-form-urlencoded`, target na própria aba, sem arquivo nem override no botão. A prévia lista campos não ocultos e marca os ocultos sem mostrar o valor. O fingerprint inclui todos os campos; a execução revalida formulário e payload, ignora handlers JavaScript de submit por meio do método nativo, e permite no interceptor apenas um POST de documento principal com URL e corpo exatos. Resposta 2xx significa `submitted` no nível HTTP. Redirect, falha ou ausência de confirmação são tratados conservadoramente; nunca há retry automático. Sites que dependem de handlers de submit ou validação remota ficam bloqueados.
