# Jev Guard public repository showcase design

**Date:** 2026-09-20  
**Status:** Approved for specification review  
**Target:** `raniellimontagna/jev-guard-mcp`

## Objective

Publish Jev Guard MCP as a credible engineering showcase on Ranielli Montagna's personal GitHub profile. The repository must make the safety boundary, working evidence and experimental status understandable without overstating browser automation capabilities.

## Audience

- engineers evaluating MCP, Jev, TypeSafe or browser-use architectures;
- people visiting Ranielli's GitHub profile;
- potential collaborators interested in safe agent execution;
- Portuguese-speaking readers who need a concise project summary.

## Positioning

Jev Guard is a supervised, browser-only decision boundary. Codex provides intent, code produces a bounded set of safe links, Jev chooses one option, and Playwright executes only after explicit approval. It is not a general-purpose computer-use agent.

The public presentation will use an engineering-showcase register: visually distinctive enough to be memorable, but grounded in implementation details, reproducible tests and explicit residual risks.

## Public repository

- GitHub owner: `raniellimontagna`.
- Repository name: `jev-guard-mcp`.
- Visibility: public.
- Default branch: `main`.
- License: MIT.
- Package status: experimental `0.1.0`; no npm publication.
- No release or version tag in this pass.
- The existing development branch remains available locally until publication is verified.

Recommended repository description:

> A guarded MCP layer for Jev-powered browser decisions with isolated Playwright execution and explicit human approval.

Recommended topics:

`ai-agents`, `browser-automation`, `computer-use`, `jev`, `mcp`, `playwright`, `security`, `typesafe-ai`

## README information architecture

The primary README will be in English for reach, with a short Portuguese summary near the top.

1. Repository-owned SVG banner with project name and the core `observe → choose → approve → navigate` sequence.
2. Factual badges only: CI, Node version, license and experimental status.
3. One-paragraph English positioning and a compact Portuguese summary.
4. A visual Mermaid flow showing Codex, policy engine, Jev and isolated Playwright responsibilities.
5. A short example of `preview` output followed by an approved `execute`, with no token or secret.
6. Safety boundary split into allowed and intentionally unsupported behavior.
7. Quickstart using Keychain-backed credentials, build and MCP configuration.
8. The three MCP tools and the approval contract.
9. Verification evidence, including the public Wikipedia smoke test.
10. Residual risks and direct links to architecture and threat-model documents.
11. Development commands, contribution expectations and license.

The README will avoid decorative claims, fake metrics, unverifiable badges, screenshots containing secrets and language implying authenticated or transactional automation.

## Visual direction

The banner will be a deterministic SVG committed to `docs/assets/jev-guard-banner.svg`. It will use a deep neutral background, high-contrast type and a restrained green accent associated with an approved safe path. It must render at GitHub desktop and mobile widths without relying on remote assets or embedded scripts.

Mermaid will communicate system flow; it will not duplicate prose. The README will use native GitHub primitives so the presentation remains fast, accessible and maintainable.

## Continuous integration

A GitHub Actions workflow will run on pushes to `main` and pull requests:

1. checkout and Node.js setup actions pinned to full commit SHAs;
2. Node.js 22 setup with npm cache;
3. `npm ci --ignore-scripts`;
4. `npx playwright install --with-deps chrome`;
5. `npm test`;
6. `npm run typecheck`;
7. `npm run build`;
8. `npm audit --omit=dev`.

The workflow must not access the TypeSafe credential or run the live smoke test. The live test remains an explicit local verification because it incurs an external model call and browser navigation.

## Publication flow

1. Implement and verify the README, SVG, license and CI locally on the feature branch.
2. Run the full local suite, build, audit, package dry-run and MCP stdio handshake.
3. Create local `main` at the verified commit.
4. Switch GitHub CLI operations explicitly to the personal account `raniellimontagna`.
5. Create the public GitHub repository and push `main`.
6. Configure description, topics and default branch.
7. Verify the public README, assets, Actions run and repository metadata from GitHub.
8. Do not pin the repository on the profile unless separately requested; public visibility is sufficient for this pass.

No force-push, secret upload, npm publication, Codex global MCP registration or release creation is part of this publication.

## Verification and acceptance

The showcase is accepted when:

- the working tree is clean;
- all local tests, typecheck and build pass;
- dependency audit reports no known production vulnerabilities;
- the package dry-run contains only intended files;
- the MCP handshake exposes exactly `jev_guard_preview`, `jev_guard_execute` and `jev_guard_cancel`;
- the public repository resolves under the personal account;
- GitHub renders the banner, Mermaid and relative links;
- the first CI run passes without secrets;
- the repository description, topics, visibility and default branch match this specification.

## Article gate

The blog article is a follow-up, not part of this repository publication. It should be written only after:

- the MCP is explicitly registered in Codex;
- preview, execute and cancel are exercised through Codex rather than only the standalone smoke script;
- a small public-page test matrix records successful, blocked and low-confidence outcomes;
- latency, token usage and material failures are captured;
- residual risks and the comparison with the three upstream approaches are refreshed.

Provisional article angle:

> How we used Jev for fast browser decisions without handing the browser to the model

The article must distinguish measured results from architectural expectations and link to the exact public commit used for the evaluation.
