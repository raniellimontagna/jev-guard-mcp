# Arquitetura do piloto

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

O TypeSafe recebe somente texto redigido e limitado: objetivo, título, trecho visível, origem/caminho público e até 80 pares de rótulo/destino. E-mails, telefones e tokens longos são substituídos antes da requisição. Query strings não são enviadas, URLs completas não são enviadas, e valores de inputs não são lidos.

Não são enviados screenshots, HTML, cookies, local storage, seletores, coordenadas ou dados do perfil Chrome.

## Preview e execução

The trusted MCP client is responsible for showing source, label and destination and obtaining explicit human approval before execute. Possession of a preview token is technical authorization; the server cannot independently attest human approval. O fluxo permanece preview → aprovação humana → execute, e o cliente deve manter o token privado.

A prévia mantém o browser aberto por até 120 segundos e armazena em memória o snapshot exato, candidato, confiança e token aleatório. Na execução, o token é removido antes de qualquer efeito. O sistema reextrai a página e compara URL de origem, ID, rótulo, destino e fingerprint. Qualquer diferença fecha o browser e falha como estado stale.

O executor navega para a URL aprovada usando `page.goto()`. Ele não dispara o click handler fornecido pela página. A rota principal só chega à rede quando coincide exatamente com a URL aprovada. Cada request HTTPS valida o hostname e usa `route.fetch({ maxRedirects: 0 })`; respostas 3xx são abortadas e somente respostas sem redirect chegam ao browser por `route.fulfill`. Isso também bloqueia redirects de subrecursos. Documentos de subframes são abortados antes de qualquer acesso à rede. A URL final continua sujeita à pós-condição exata. A URL inicial pode conter query; candidatos de navegação não podem.

O SessionStore reserva capacidade antes de abrir browser ou chamar o modelo. A reserva acompanha abertura, decisão pendente, token armazenado e execução consumida; fechamento, expiração, cancelamento, erro e decisões terminais liberam a reserva. Shutdown rejeita novo trabalho, fecha reservas com browsers ativos e aguarda aberturas já iniciadas para fechá-las, sem depender de uma resposta do modelo. Erros MCP usam uma allowlist de códigos e mensagens constantes e um fallback genérico, sem repassar mensagens de dependências.

## Dependências e credenciais

As dependências diretas e o modelo `jev-1.13.0` são fixados. O SDK TypeSafe usa base URL constante, zero retries automáticos, timeout de 10 segundos e logging desligado. O cliente rejeita respostas que aleguem outro modelo ou tragam métricas de uso inválidas. A chave vem somente do ambiente; `scripts/run-from-keychain.sh` pode carregá-la do Keychain sem imprimi-la.
