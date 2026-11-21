---
name: pr-description
description: Mandatory style for PR/MR titles and descriptions. Load before calling shirei_pr_create, gh pr create/edit, glab mr create/update with a description, or editing any review description. Enforces a why / API changes with usage examples / validation shape, word budgets, no verification transcripts, and no internal names in public repos.
---

# PR and MR descriptions

A description tells a reviewer why the change exists, how any API surface changes for its callers, and how the change was validated. The diff already shows what changed; the description is not a log of the work.

## Title

Match the repository's recent merged titles (`git log --oneline -15 origin/<trunk>` or the forge's merged list): a ticket prefix (`KEY-NNNN: Sentence-case imperative`), Conventional Commits (`type(scope): lowercase imperative`), or a sentence-case imperative with no prefix. When an installed skill lists conventions for specific repositories, it wins.

At most 72 characters. One change per title; no comma-joined lists.

## Budget

`shirei pr create` / `shirei_pr_create` enforce these budgets (prose words, excluding the stack-links block and code blocks). Aim well under them; for direct `gh`/`glab` edits, count yourself.

| Change | Words | Headings |
|---|---|---|
| Small: about 100 changed lines or fewer, one concern | at most 80 | none |
| Medium | at most 200 | optional |
| Large or cross-system | at most 350, at most 30 lines | allowed |

A description that cannot fit its budget means the change should be split, or the extra content belongs in a README, ADR, or code comment.

## Shape

Three sections, in this order. Use the headings `## Why`, `## API changes`, and `## Validation` on medium and large changes; on small ones write them as three short paragraphs.

1. **Why:** 1–3 sentences on the problem or the user-visible effect, and the approach when it is not obvious from the title. Name the design choice a reviewer might question.
2. **API changes**, only when an API surface changed. A surface is anything another piece of code, a user, or an agent calls or configures, internal or external:
   - exported functions, classes, types, and schemas
   - RPC and HTTP endpoints, Durable Object and Worker bindings, queue or event payloads, persisted formats
   - CLI commands and flags, slash commands, pi tools and their parameters, config and settings keys, environment variables

   For each one, show how a caller uses it in a fenced code block: the call, request, or command with realistic arguments and the result or response. For a changed surface, show before and after. Code blocks do not count toward the word budget, so prefer a short example over describing the API in prose. Omit the section when no surface changed.
3. **Validation:** how you know it works, in 1–3 lines or bullets: which tests cover it (and that the regression test fails without the fix), the manual or end-to-end run you did and what it showed, and the one number that matters when there is one. Add "Not validated: X" only when a reviewer would assume X was.

Only when true, after Validation:
- `Needs before merge:` or `Needs after merge:` with steps someone else must take
- a real limitation a reviewer would otherwise miss

Example (medium change that adds a command and blocks a tool call):

````markdown
## Why
An unattended session launched 13 review agents of its own on top of the automatic audit. The agent can no longer launch reviewers; the user runs the correctness review on demand instead.

## API changes
New `/correctness [focus]` command, scoped like `/audit`:

```text
/correctness the lease renewal path
→ Correctness review running on 3 files (base origin/main@fd3549e)
→ C1 src/lease.ts:88 warning  renewal can race expiry  correctness/race
```

`Agent` calls from the main session with a review `subagent_type` now fail:

```json
{ "subagent_type": "correctness-review", "prompt": "…" }
→ blocked: Reviews run only from the post-change audit or from /audit, /correctness, and /review-mr.
```

## Validation
- A fake-context test covers every blocked type, resumes, retries after a failed spawn, and subagent sessions.
- A real `/correctness` run spawned the reviewer in a test worktree and delivered C1–C4; a real `/audit` still spawned its reviewers.
````

## Never include

- command transcripts, pass counts, seed numbers, test-run or batch links
- a "What changed" list, file-by-file tables, line counts, changed-file lists, or any other restatement of the diff
- per-commit narration or commit SHAs
- "Not run" or "Not verified" inventories
- how the work was found (session mining, audits, "a month of logs showed")
- what bots already post (deployed workers, AI review, previews)
- reviewer or merge chatter

## Updating a description

Rewrite it to the current state; never append status, measurements, or follow-ups. Remove status and rollout items once done. Re-check the budget after every edit.

## Public repositories

Treat a repository as public unless it is on your organization's private forge. In public repositories never mention internal services, tools, test harnesses, hosts, links, tickets, or runtime-internal symbols; describe them generically ("randomized fault-injection tests"). An installed skill may list the private hosts and the exact names to avoid. GitHub keeps every edit, so get it right before the first publish.

## Stack, draft, reviewers

- Shirei writes and refreshes the previous/next links on every review in the stack (and rejects a `## Stack` section). Add one sentence such as "Merge after !N" only when the order is not obvious.
- Draft only when asked, or for red-test PRs, experiments and comparisons, or work blocked on an unmerged dependency.
- Never add or change reviewers or assignees unless asked.

## Preview

For medium and larger changes, show the title and body in chat before calling the tool.

## Self-check before submitting

1. Delete every sentence a reviewer would not miss.
2. In public repositories, grep the title and body for the internal names you know of (and any an installed skill lists) and remove every hit.
