# Supervised Jev browser mode

**Date:** 2026-09-28
**Status:** Approved; implemented locally on the feature branch
**Target branch:** `codex/jev-browser-integration`

## Objective

Let Codex provide a goal and exact, non-credential form values while Jev chooses browser actions on public or authenticated sites. Every Jev-proposed browser-changing action is previewed for the user. Form values are approved before they can be filled or transmitted. Playwright executes only code-owned actions after a fresh, single-use approval token is supplied by a trusted MCP client. Opening the user-specified start URL and the user's manual login are separate, user-directed actions.

The current three `jev_guard_*` tools and their public, JavaScript-disabled policy remain unchanged. The new mode has separate tools, browser sessions, decision contracts and threat-model documentation.

## Upstream choices

- [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) demonstrates a bounded action-and-element choice from an indexed page and freshness checks. Its Chrome-profile and text-generation choices are not adopted.
- [jkudish/jev-browser](https://github.com/jkudish/jev-browser) provides useful TypeScript, MCP and multi-step navigation patterns. Its internal action loop cannot be used unchanged because this server must pause before each action.
- [Ying-Kai-Liao/jev-browser](https://github.com/Ying-Kai-Liao/jev-browser) shows the desired separation between agent planning and Jev execution. Its model-scored irreversible gate and treatment of raw values are not adopted.

These projects are references under their MIT licenses, not runtime dependencies. Any copied code requires license attribution. The implementation should prefer the repository's existing TypeSafe and Playwright adapters.

## Scope and modes

The first implementation supports one browser tab per in-memory session, a bounded sequence of link, disclosure/tab button, fill, select, scroll and wait actions, and standard HTTPS `POST` forms whose exact action URL can be established before execution. Other buttons require a reviewed, code-owned site policy describing their effect. JavaScript-driven form submission is allowed only when that policy declares one exact method and endpoint; otherwise the action is blocked. Uploads, downloads, payments, deletion, private-network destinations, new tabs, unknown submission endpoints and arbitrary JavaScript are out of scope.

Public mode starts with a fresh isolated browser context. Authenticated mode starts with a separate headed context in which the user performs login manually. The server never accepts passwords, one-time codes or cookies as tool arguments, never attaches the personal Chrome profile, and never persists the browser profile. After the user signals that login is complete, the first preview checks that the page returned to `siteOrigin` and no password field is visible before entering the supervised action loop; otherwise it returns `login_required`. Restart or session close loses the login state.

The caller supplies the exact `siteOrigin` and any required public `authOrigins` and `resourceOrigins`. Jev-proposed navigation and submissions remain on `siteOrigin`; `authOrigins` are available only during manual login. A local, process-owned CONNECT proxy pins each outbound connection to a checked public IP and exact allowed host/port; this also covers browser-followed redirects that Playwright route callbacks do not re-intercept. Playwright routing separately checks HTTPS URLs, request methods and exact approved destinations. In the supervised phase, it blocks every non-GET/HEAD request except a single approved submission; `resourceOrigins` serve only GET/HEAD resources. JavaScript is enabled only in this new mode; service workers, WebSockets, downloads and popups remain blocked. A site that needs additional network access, including GraphQL reads over POST, fails closed until a reviewed site policy covers it.

## MCP interface

| Tool | Contract |
|---|---|
| `jev_browser_open` | Accepts start URL, goal, mode, exact site/auth/resource origins, optional non-credential values keyed by semantic names, and optional `expectedResult` (exact URL or visible text). Returns an opaque session ID and whether manual login is pending. Authenticated mode requires an explicit `shareRedactedPageTextWithTypeSafe` opt-in. |
| `jev_browser_preview` | Observes the current page and asks Jev for one bounded action, `done`, or `blocked`. Returns an exact action preview, confidence, expiry and a single-use token. It does not execute the action. After manual login, the first preview also ends the manual phase. |
| `jev_browser_execute` | Consumes the token, re-observes the page and executes exactly the previewed action if it is still identical and permitted. Returns the observed result and session ID. It never chains into the next action. |
| `jev_browser_cancel` | Consumes a pending token and closes the browser session. |
| `jev_browser_close` | Closes an idle or completed session and clears values, tokens and browser state. |

The trusted MCP client must display the source, action label, destination, values relevant to the action, confidence and risk before invoking `execute`. As in the existing guard, possession of a token is technical authority; the server cannot independently prove that a human approved it. All mutating tools declare appropriate MCP annotations. Rejection or expiry never triggers an automatic retry.

## Decision and action flow

1. Playwright reads an accessibility-oriented, bounded text snapshot and builds stable IDs for visible elements. The snapshot contains labels, roles, nearby text and code-computed destinations, not raw HTML, selectors, screenshots, cookies or current input values.
2. Policy code removes actions that leave the approved site, target hidden or disabled elements, download files, or have an unknown effect. Jev receives only the goal and the remaining IDs and descriptions. Jev chooses an action type, an element ID and, for fill/select, a value key. It cannot invent a selector, URL or text value.
3. A choice below the effective confidence floor of `0.80` returns `low_confidence` without a token. `done` is reported as `done_unverified` unless a caller-supplied `expectedResult` matches the observed URL or visible text; only that match returns `verified_done`. A session allows at most 20 executed actions, 25 TypeSafe calls and 15 minutes from opening, including manual login. Exhausted budgets return `blocked`. Terminal results close the browser.
4. `preview` exposes one action for human review. The session retains the page and a cryptographic fingerprint of its URL, element identity, action, destination and relevant form state. At most two browser sessions may exist concurrently. Only one pending token exists per session; it expires after 120 seconds.
5. `execute` consumes the token before acting, re-observes the page and requires an exact fingerprint match. The result is one observed state transition. Codex may request another preview for the same goal; it does not choose browser elements.

Navigation and control clicks use the actual DOM element because dynamic sites may depend on handlers. They are never treated as inherently read-only. A click that could submit a form is classified as submission before preview. If its effect or destination cannot be bounded, no executable token is issued.

## Values, authentication and submission

Only non-credential values may be supplied through MCP. Values stay in process memory for the session and are not sent to TypeSafe or placed in logs. Jev sees semantic value keys and field labels. For a fill or select action, the preview shows the exact value and site origin because input/change handlers can attempt to transmit data immediately. Before approval, no value is filled. From the first fill or select until an explicitly approved submission or cancellation, the network route aborts every new request, including GET resources and background requests. Sites requiring remote field validation are unsupported in this implementation. An approved submission opens the route for at most its one exact request, then closes it again.

A submission preview shows the source page, form and button labels, exact HTTPS method and destination, and all non-secret fields that would be sent. Hidden security tokens are described without exposing their values. The execution fingerprint covers every submitted field, including hidden values. File inputs and fields whose values cannot be represented safely block the submission. The network layer permits at most one request with the approved method and exact destination, and aborts unexpected requests or redirects. If the request may have reached the server but confirmation is missing, the result is `outcome_unknown`; the server does not retry. A redirect after submission is not treated as proof of success.

For authenticated pages, the user explicitly opts in before any redacted page text is sent to TypeSafe. Redaction is best-effort and does not make arbitrary private content safe; the tool description and opening result disclose that limit. Credentials, current input values, cookies, local storage and hidden fields are never sent. The user should choose sites and tasks with that data-sharing boundary in mind.

## Errors, lifecycle and observability

Sessions and tokens are in memory, capacity-limited and closed on cancellation, expiry, shutdown or fatal error. MCP errors are fixed code/message pairs and never include a page body, value, token, dependency exception or credential. Results may include bounded redacted page text and a trace of action types, labels, destinations, confidence and observed outcomes. Traces are returned to the caller but not written to disk by the server.

The browser network policy cannot prove that a remote GET or a site's JavaScript is side-effect-free. The design therefore asks for approval before every action and blocks unbounded effects. Authenticated browsing also exposes page text to the TypeSafe service after opt-in. Those residual risks belong in a separate threat model and in the MCP tool descriptions.

## Verification and acceptance

- The existing nine test files, three public MCP tools and their behavior remain intact.
- A synthetic public-site fixture proves a multi-step read flow where Jev chooses elements and the user-approved executor performs one action per token.
- A synthetic authenticated-site fixture proves manual login handoff without passing credentials to MCP or TypeSafe. Fixture transport may stand in for localhost; production URL policy continues to block localhost.
- Synthetic forms prove exact value preview, pre-fill approval, exact destination/method enforcement, stale form rejection, token reuse rejection, one-request limit and no retry after an ambiguous result.
- JavaScript `input`/`change` handlers, unexpected XHR/fetch requests, redirects, popups, downloads and private or cross-origin requests fail closed.
- Injected TypeSafe transport tests prove that raw values, passwords, cookies and hidden fields are absent from model inputs.
- MCP schema tests verify all new annotations and bounded error responses. Build, typecheck and the full suite pass.
- No real authenticated site or external form is submitted in automated or live verification. A real-site pilot requires a named site, a reviewed origin policy and the user's approval of each actual action.

The change is delivered on the feature branch for review. Publishing, pushing, changing the global Codex MCP registration and sending a real form are separate actions.

## Implementation notes

The first implementation handles native URL-encoded HTML POST forms. It does not include a reviewed site adapter for JavaScript-managed forms. The preview's source URL omits query strings to avoid disclosing URL tokens in MCP results; the full URL remains private for freshness checks. The authenticated open result includes a privacy notice about best-effort redaction. A 2xx response confirms HTTP receipt only; the form session closes after its one attempt, so any business outcome still requires independent observation.
