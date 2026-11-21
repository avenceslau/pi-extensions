---
name: affirmations
description: Mine past Pi sessions and the team's merged review comments for recurring corrections, and propose moving each into the harness, a judged hygiene rule, or a deterministic rule.
disable-model-invocation: true
---

# Affirmations

Find what the user and the team keep correcting by hand, and propose where each correction should live so it stops recurring. This skill takes no request; it always runs the whole procedure below over all of the history: every main session and every merged review in every listed repository. Never sample, never keep only the top few, never stop at a count. It proposes changes and writes a report. It implements nothing until the user picks items.

## Inputs

- Repositories: `~/.config/affirmations/repos`, one `host/path` per line (`gitlab.com/group/project`, `github.com/owner/repo`), `#` comments allowed. If the file is missing or empty, ask the user which repositories their team reviews, write the file, and continue.
- Earlier reports: `~/.plans/affirmations/*.md`. Mark findings already proposed there, and say when one keeps recurring after it was declined or shipped.

## Destinations

Know what exists before proposing anything. Read:

- the harness: `~/.pi/agent/AGENTS.md`, the skills and agent definitions of every installed Pi package (`pi list`) and in `~/.agents/skills/` and `~/.pi/agent/agents/`, and the `pi-extensions` package (its `README.md` describes every extension, guard and the post-change audit);
- the hygiene rules: `extensions/hygiene/traits/<group>/*.ts` in `pi-extensions` and the `TRAITS` list in `extensions/hygiene/traits.ts`;
- each repository's own lint configuration (oxlint, eslint, biome, clippy, golangci) when a finding is specific to it.

Classify each finding into exactly one destination, taking the first that fits:

1. **Deterministic rule**: a check that needs no judgment, decidable from syntax, text or file layout. Either a hygiene trait with `check: "local"` (it applies across repositories) or a rule in the repository's linter (it is repo-specific or a standard linter already has it; name the rule).
2. **Hygiene rule (judged)**: needs judgment about code, but on a snippet or window of code. A trait with `check: "clef"` (short snippets, yes/no) or `check: "agent"` (needs surrounding context).
3. **Harness**: about how the agent works rather than the code it writes: which tools it uses, worktrees, reviews, PR descriptions, what it asks, when it stops. Prefer enforcement in an extension (a guard that blocks a tool call, a hook that injects context, a tool that does the step) over prose. Prose goes in `AGENTS.md` when it applies everywhere, or in the skill it belongs to. When prose already says it and the agent still violates it, propose enforcement.
4. **Leave to review**: needs design or cross-file reasoning no rule can capture. List these briefly; do not propose rules for them.

When an existing rule already covers a finding, the proposal is to change that rule (tighten the requirement, add an example, bump `version`), not to add another. A rule the user keeps declining is a finding too: propose narrowing or removing it.

## Gather

Both scripts live in this skill's directory (`<skill dir>` below) and print one JSON object per line. Write their output to a temp directory and query it with `jq`; do not read it raw.

```sh
dir=$(mktemp -d)
<skill dir>/session-signals.sh > "$dir/sessions.ndjson"
grep -v '^\s*\(#\|$\)' ~/.config/affirmations/repos | xargs <skill dir>/review-comments.sh > "$dir/reviews.ndjson"
```

- `session-signals.sh [cwd substring]` covers every main session; subagent sessions are skipped. `kind: "user"` is what the user typed; `kind: "decision"` is a post-change audit finding with `decision` `fixed` or `declined`, its `claim`, `reason` and source `path`; `kind: "tool_error"` is a failed or blocked tool call.
- `review-comments.sh <host/path>...` prints human comments on every merged review, excluding bots, service accounts and the review author's own replies, with `path` and `line` for inline comments. Merged reviews are cached in `~/.cache/affirmations/reviews`, so only new ones are fetched. Failed requests are reported on stderr and retried on the next run; list them in the report.

The output is too large for one context (the sessions alone run to many megabytes). Split all of it into slices: sessions by repository (Shirei worktrees under `~/.local/share/shirei/worktrees/<repo>/<branch>` belong to `<repo>`), and further by time until each slice is under about 1 MB; reviews by repository and time the same way. Hand every slice to a `research` subagent, running them in parallel, with this skill's Destinations and Look for sections, and ask for every finding in the slice with all its occurrences cited. No slice is skipped. Merge the results yourself: combine the same finding across slices and add up its occurrences.

## Look for

- **User corrections**: messages that undo or redirect the agent ("no", "don't", "stop", "I said", "instead", "again", "always", "never", "why did you"). Read the assistant turn before each one in the session file to see what was corrected.
- **Repeated instructions**: the same request typed in several sessions ("use a worktree", "run the tests", "keep it short").
- **Audit decisions**: findings fixed again and again are candidates for an earlier or cheaper rule; clusters of `declined` with similar reasons show a rule that misfires.
- **Tool errors**: the same failure across sessions (a blocked command, a wrong flag, a missing tool) usually belongs in the harness.
- **Review comments**: the same kind of comment from teammates across several reviews, especially ones the post-change audit should have caught.

A finding with two or more independent occurrences (different sessions or different reviews), or one with a high cost (a reverted change, a production issue, a blocker comment), gets a proposal. Report one-offs too, in their own section, so a later run can see them recur.

## Report

Write `~/.plans/affirmations/<YYYY-MM-DD>.md` with every finding, ordered by how much repeated effort it would remove, each with:

- the problem in one sentence;
- evidence: the count and every occurrence (session file and timestamp, or review URL with a short quote);
- destination and why it fits there rather than the next one up;
- the concrete change: the trait (name, `check`, `requirement`, `candidate`, `fix`), the linter rule and its config line, the extension hook and the behavior it enforces, or the exact `AGENTS.md`/skill sentence;
- whether it replaces or modifies something that exists.

End with the one-offs, the leave-to-review items, and any repositories or requests that failed.

In chat, list every finding as one line with its destination and count, and ask which to implement. Implement only the ones the user picks, following `AGENTS.md` (a worktree of the repository that owns the change, and a review for each).
