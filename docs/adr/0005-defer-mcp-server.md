# 5. Defer MCP server; operator workflow via Convex Dashboard

Date: 2026-05-28

Status: Accepted

## Context

The original design proposed a v1 MCP server exposing tools like `list_suggested_rules`, `promote_suggested_rule`, and `trigger_review`. The rationale was that learning-loop promotion needs an operator surface, and MCP integrates naturally with Claude Code.

Re-examination: the operator workflow is fundamentally CRUD on Convex tables, and the Convex Dashboard already provides exactly that interface. Building an MCP server in v1 means shipping a parallel UI to one Convex already provides for free.

## Decision

Sandy v1 ships without an MCP server. Operator workflows are conducted via the Convex Dashboard.

The promotion workflow uses Convex's reactive subscriptions:

- Operator opens the Convex Dashboard → `suggestedRules` table → edits a row's `status` to `promoteToPositive`, `promoteToSuppression`, or `rejected`.
- The Sandy worker is reactive-subscribed to `suggestedRules`. Status change triggers the appropriate downstream action:
  - `promoteToPositive` → worker drafts a Rule from Archetype examples and opens a PR adding a line to `.bot/product-rules.md` in the relevant Repo.
  - `promoteToSuppression` → worker flips the Archetype's `suppressionWeight` and marks the SuggestedRule promoted.
  - `rejected` → no action; the row remains as history.

## Consequences

- **No port 7777, no Bearer token, no `claude mcp add` setup.** Simpler ops, smaller attack surface.
- **Operator UI is fixed for v1** at "edit cells in Convex Dashboard." Adequate for solo use; not great if other operators are introduced.
- **MCP not foreclosed** — adding it later is purely additive. The same Convex backend serves both the dashboard and any future MCP server.
- **CLI is the natural intermediate step** if dashboard editing becomes painful before MCP justifies itself.
- **The Convex Dashboard is technically a SaaS UI.** The original spec said "skip dashboard," but the intent was "don't build a bespoke dashboard," not "don't use any existing admin surface." Convex Dashboard is the operator's natural extension of choosing Convex Cloud (ADR 0004).

## When to revisit

Reconsider when (a) editing cells in Convex Dashboard becomes the most-painful part of operating Sandy, or (b) a multi-step operator workflow needs to be composed inside Claude Code (e.g., "find all 👎 on security findings this month and promote the top 3 as suppressions"). The CLI option should be evaluated before MCP.
