---
name: glab
description: Use GitLab CLI (`glab`) for merge request lifecycle and code review on GitLab-hosted repos. Load when creating, viewing, updating, approving, or commenting on merge requests. Biases toward live retrieval from `glab <cmd> --help` and GitLab CLI docs over pre-trained knowledge. Scope is MR lifecycle + review only — issues, CI/CD, repo admin, and raw API are out of scope.
---

# glab (GitLab CLI)

`<skill dir>` below is this skill's directory.

Your knowledge of `glab` flags, subcommands, and output shapes may be outdated. **Prefer live retrieval over pre-training** for any `glab` invocation.

## Hard Rules — non-negotiable

1. **NEVER run `glab mr merge` or any merge-equivalent.** Merging is a human-only action. The agent's terminal state is "MR is ready to merge" — then stop and hand off. This is enforced by OpenCode permission (the command will prompt for explicit user approval), and by this skill's policy regardless of the prompt outcome. Do not attempt workarounds: `glab api .../merge_requests/.../merge`, `glab alias` tricks, `bash -c`, `xargs`, wrapper scripts, or web-UI links. If the user asks the agent to merge, refuse and explain.

2. **ALWAYS create MRs with `--squash-before-merge`.** No exceptions. Repo policy is squash-on-merge. Pair with `--remove-source-branch` to keep branches clean. If you create an MR without it, fix immediately with `glab mr update <id> --squash-before-merge`.

3. **MR descriptions are short and decision-focused.** ≤10 lines. Explain the decisions made and how they affect the systems — nothing more. No commit-log dumps, no restated diffs, no walls of context, no `## What` that just paraphrases the title or the diff.

4. **ALWAYS request review from CODEOWNERS when target is the default branch.** GitLab does not auto-assign codeowners as reviewers — they're only added as approval rules. Run `<skill dir>/scripts/resolve_codeowners.py` and pass its output via `--reviewer`. Skip this on stack-internal frames (target ≠ default branch) — those don't need review until the stack lands on the default branch. After-the-fact recovery uses `--reviewer +user1,+user2,...` (note the leading `+`); a bare `--reviewer user1,user2` on `update` **replaces** the existing list, which is the actual mechanism that removes codeowners someone else added.

## Retrieval-first

Before authoring any `glab` command:

- Run `glab <cmd> --help` to confirm current flag names and semantics
- For non-obvious workflows, fetch https://docs.gitlab.com/editor_extensions/gitlab_cli/ or https://gitlab.com/gitlab-org/cli

Never rely on flag names from memory. The skill references below document what was valid at authoring time, but live `--help` is the source of truth.

## Host auto-detection

`glab` reads the GitLab host from the current repo's git remote (origin by default). **Do not** set `GITLAB_HOST`, `-R`, or `--repo` when operating on the current repo. Use `-R owner/repo` only for cross-repo operations (rare).

## When to use

- Creating MRs from a feature branch
- Viewing, diffing, or checking out an MR for local review
- Listing MRs by assignee / reviewer / label
- Adding review comments or approvals
- Updating MR metadata (title, description, labels, reviewers, draft/ready)

## When NOT to use

- Issues (`glab issue`), CI/CD pipelines (`glab ci`), repo admin (`glab repo`), releases, raw `glab api` — run `glab --help` and handle directly; this skill does not cover them
- Merging — see Hard Rule #1

## Quick reference

### MR lifecycle

| Command | Purpose |
|---|---|
| `glab mr create --squash-before-merge --remove-source-branch -t "<title>" -d "<short desc>"` | Create MR (required flags in bold context) |
| `glab mr view <id\|branch>` | Title, body, metadata |
| `glab mr view <id\|branch> --comments` | Include threads/notes |
| `glab mr view <id\|branch> -F json` | JSON for scripting |
| `glab mr diff <id\|branch>` | Show diff |
| `glab mr checkout <id\|branch\|url>` | Pull MR locally |
| `glab mr list --assignee=@me` | MRs assigned to you |
| `glab mr list --reviewer=@me --not-draft` | MRs awaiting your review |
| `glab mr update <id\|branch> ...` | Edit title/description/labels/draft/squash |
| `glab mr rebase <id\|branch>` | Rebase source onto target server-side |
| `glab mr close <id\|branch>` / `reopen` | State transitions |
| ~~`glab mr merge`~~ | **BLOCKED — human-only; see Hard Rule #1** |

### Review

| Command | Purpose |
|---|---|
| `glab mr approve <id\|branch>` | Approve |
| `glab mr revoke <id\|branch>` | Revoke your approval |
| `glab mr note <id\|branch> -m "<comment>"` | Add a comment / note |
| `glab mr note <id\|branch> -m "..." --unique` | Only post if identical note doesn't exist |
| `glab mr todo <id\|branch>` | Add a to-do reminder for yourself |
| `glab mr subscribe <id\|branch>` / `unsubscribe` | Notification control |

## Common flows

### Create MR from current branch (canonical form)

```bash
REVIEWERS=$(<skill dir>/scripts/resolve_codeowners.py)
glab mr create \
  --squash-before-merge \
  --remove-source-branch \
  ${REVIEWERS:+--reviewer "$REVIEWERS"} \
  -t "Add foo to bar" \
  -d "## Decisions
One–two sentences naming the choice(s) made and any alternatives worth flagging.

## System impact
One–two sentences on what other components, callers, data, or operators are affected." \
  --yes
```

- `--squash-before-merge` is **required** (Hard Rule #2)
- `--reviewer` from `resolve_codeowners.py` is **required** when targeting the default branch (Hard Rule #4). The helper reads `CODEOWNERS`, matches the branch's changed files, expands any `@group/path` mentions via `glab api groups/<id>/members`, and prints a comma-separated username list with the current user removed. Empty output = no rule applied = skip the `--reviewer` flag (the `${VAR:+...}` substitution handles this).
- For stack-internal frames (target ≠ default branch), skip the resolver step.
- `-t` / `-d` are explicit so you control title and description (avoid `--fill` — see anti-patterns)
- `--yes` skips the confirmation prompt
- Add `--draft` if the branch isn't ready for review
- Override or extend reviewers with `--assignee @me --reviewer extra-user` as needed

### Review an MR locally

```bash
glab mr checkout 123
glab mr diff 123
glab mr view 123 --comments
```

### Approve or leave a review note

```bash
# Approve
glab mr approve 123

# Request changes / leave a comment
glab mr note 123 -m "Line 42 has an off-by-one; wrap the loop condition in a guard."
```

### Hand off "ready to merge" (agent terminal state)

After the MR is created, approved, pipeline green, and threads resolved, report to the user:

> MR !<id> is ready to merge. I will not run `glab mr merge` — please merge when ready.

Then stop.

## Anti-patterns

| Anti-pattern | Why it matters |
|---|---|
| Running `glab mr merge` from the agent | Hard-blocked by policy and OpenCode permission; merging is human-only |
| `glab api ...merge_requests/.../merge` as a back door | Same — blocked at permission layer; violates policy |
| Setting a `glab alias` that wraps merge | Circumvention attempt; policy is on intent, not syntax |
| `bash -c 'glab mr merge ...'` / `xargs glab` / custom wrappers | Same — do not attempt |
| `glab mr create` without `--squash-before-merge` | Violates repo policy (Hard Rule #2) |
| `--fill` on a multi-commit branch | Concatenates every commit body into the description → long, noisy, violates Hard Rule #3 |
| Description >~10 lines, commit logs/diffs pasted in, or a `## What` that paraphrases the title/diff | Reviewers skim — only decisions and system impact justify their time |
| `--rebase` on merge as an alternative to `--squash` | Bypasses the squash policy even if merging were allowed |
| Hand-setting `-R` / `GITLAB_HOST` in-repo | Redundant; host comes from git remote |
| Hardcoding MR IDs where a branch name works | Most `glab mr` commands accept `<branch>` — more readable |
| Omitting `--unique` on idempotent review notes | Re-running a script spams the thread |
| Creating a default-branch MR without `--reviewer` from `resolve_codeowners.py` | Violates Hard Rule #4 — codeowners aren't auto-assigned as reviewers server-side, so the MR ships with no one tagged |
| `glab mr update <id> --reviewer user1,user2` (bare, no `+`) | Replaces the entire reviewer list — wipes any codeowners or extra reviewers someone else added. Use `+user1,+user2` to add. |

## Limitations of the block

The hard block on `glab mr merge` is enforced at the OpenCode bash-permission layer and by this skill's policy. Known residual paths that are **not** auto-blocked:

- `glab alias set` internal aliases — glab expands these inside its own binary before OpenCode's parser sees the final command. The skill forbids using or setting such aliases.
- `glab mr view --web` → browser → click merge. Out of scope for CLI blocking.
- `git push` directly to the protected target branch. Belongs to server-side branch protection, not this skill.

If a user asks the agent to use any of the above to merge, refuse.

## References

- `references/mr.md` — full MR lifecycle: create, view, diff, checkout, list, rebase, update, close
- `references/review.md` — approve/revoke, notes, threads, suggestion blocks, resolution

## Principles

- **Retrieve before running.** Run `glab <cmd> --help` first; flag names drift.
- **Stop at "ready to merge."** Agent's job ends there. The human merges.
- **Decisions and system impact, nothing else.** Description is for what the diff can't show.
- **Branch names over IDs** when both work — more readable logs.
- **`-R` only for cross-repo.** In-repo commands inherit from git remote.
