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

A prévia mantém o browser aberto por até 120 segundos e armazena em memória o snapshot exato, candidato, confiança e token aleatório. Na execução, o token é removido antes de qualquer efeito. O sistema reextrai a página e compara URL de origem, ID, rótulo, destino e fingerprint. Qualquer diferença fecha o browser e falha como estado stale.

O executor navega para a URL aprovada usando `page.goto()`. Ele não dispara o click handler fornecido pela página. A rota principal só chega à rede quando coincide exatamente com a URL aprovada; redirects, query strings e outros caminhos são bloqueados antes do request e ainda há uma pós-condição sobre a URL final.

## Dependências e credenciais

As dependências diretas e o modelo `jev-1.13.0` são fixados. O SDK TypeSafe usa base URL constante, zero retries automáticos, timeout de 10 segundos e logging desligado. O cliente rejeita respostas que aleguem outro modelo ou tragam métricas de uso inválidas. A chave vem somente do ambiente; `scripts/run-from-keychain.sh` pode carregá-la do Keychain sem imprimi-la.
