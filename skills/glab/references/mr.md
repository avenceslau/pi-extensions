# MR Lifecycle

Full reference for merge request commands. Always run `glab <cmd> --help` to confirm flags before invoking.

## Create — `glab mr create`

### Required flags (per skill policy)

| Flag | Why |
|---|---|
| `--squash-before-merge` | Hard Rule #2 — repo policy is squash-on-merge |
| `--reviewer "$(resolve_codeowners.py)"` | Hard Rule #4 — when targeting the default branch. See [Codeowner resolution](#codeowner-resolution). |

### Recommended defaults

| Flag | Why |
|---|---|
| `--remove-source-branch` | Keep branches clean after merge |
| `-t` / `--title "<imperative, ≤72 chars>"` | Explicit title — avoid editor prompt |
| `-d` / `--description "<short What/Why>"` | Explicit, short description — avoid `--fill` noise |
| `--yes` | Skip submission confirmation |

### Codeowner resolution

GitLab evaluates `CODEOWNERS` for approval rules, but does **not** add codeowners to the MR's reviewer list. Without a `--reviewer` flag, your MR ships with zero reviewers tagged.

Use `<skill dir>/scripts/resolve_codeowners.py`:

```bash
REVIEWERS=$(<skill dir>/scripts/resolve_codeowners.py)
echo "$REVIEWERS"
# acruz,atlantis,caio,celso,efalcao,jdelorey,kadler,lduarte,osilva,sid,vaishnav
```

The helper:
1. Finds `CODEOWNERS`, `.gitlab/CODEOWNERS`, or `docs/CODEOWNERS` in the repo
2. Computes changed files via `git diff <target>...HEAD` (default target: `origin/HEAD`)
3. Matches each file against CODEOWNERS rules using last-match-wins semantics
4. Expands `@group/path` mentions via `glab api groups/<encoded>/members` (direct members only — matches how GitLab itself expands group codeowners; inherited members are excluded)
5. Drops the current user
6. Prints a sorted comma-separated username list

Empty output = no applicable CODEOWNERS rule. Skip `--reviewer` entirely in that case (the `${VAR:+...}` substitution in the canonical command handles this).

**When NOT to invoke**: stack-internal frame MRs (target ≠ default branch). Those frames don't need review until the stack rebases onto the default branch — assigning codeowners on each frame just spams them.

Pass `--target` to override the diff base:

```bash
<skill dir>/scripts/resolve_codeowners.py --target origin/release/2026.05
```

### Canonical invocation

```bash
REVIEWERS=$(<skill dir>/scripts/resolve_codeowners.py)
glab mr create \
  --squash-before-merge \
  --remove-source-branch \
  ${REVIEWERS:+--reviewer "$REVIEWERS"} \
  -t "Add rate limiting to /api/login" \
  -d "## Decisions
IP-based rate limiting on /api/login, 5 req/min. Chose IP over user-id because abuse hits unauthenticated requests.

## System impact
Adds Redis dependency on the auth path. Shared-NAT users may see 429s under sustained traffic — flagged in SEC-1234." \
  --yes
```

### Description authoring

- **Length ceiling**: ≤10 lines, including blank lines and headers. Sentence count is not the limit; relevance is.
- **Focus**: the decisions you made and how they affect the systems. If the diff already shows it, don't write it. No `## What` that paraphrases the title.
- **Template**:
  ```
  ## Decisions
  <1–2 sentences: the choice(s) made and any alternatives worth flagging>

  ## System impact
  <1–2 sentences: what other components, callers, data, or operators are affected>
  ```
- **Shell-escaping multi-line `-d`**: use a single-quoted heredoc or `$'...'` — never unescaped backticks, never nested double quotes. Example:
  ```bash
  DESC=$(cat <<'EOF'
  ## Decisions
  ...

  ## System impact
  ...
  EOF
  )
  glab mr create --squash-before-merge --remove-source-branch \
    -t "..." -d "$DESC" --yes
  ```

### Optional flags

| Flag | Purpose |
|---|---|
| `--draft` (or `--wip`) | Mark as draft until ready for review |
| `-a` / `--assignee username[,username...]` | Assign users (use `@me` for yourself) |
| `--reviewer username[,username...]` | Request reviewers |
| `-l` / `--label name[,name...]` | Apply labels |
| `-m` / `--milestone <id-or-title>` | Assign milestone |
| `-b` / `--target-branch <branch>` | Target other than default branch |
| `-s` / `--source-branch <branch>` | Source other than current branch |
| `-i` / `--related-issue <id>` | Link to issue; uses issue title if `-t` omitted |
| `--copy-issue-labels` | With `--related-issue`, copy labels from issue |
| `--allow-collaboration` | Allow commits from other members |
| `--create-source-branch` | Create the source branch if missing |
| `--push` | Push committed changes first (auto-set by `--fill`) |
| `--no-editor` | Don't open editor; use prompts |
| `--signoff` | Append DCO signoff to description |
| `-H` / `--head <owner/repo>` | Fork head repository |
| `-w` / `--web` | Continue creation in a browser |

### `--fill` — when acceptable

`--fill` skips interactive prompts and uses commit info for title/description. It also sets `--push`.

- **Acceptable**: single-commit branches where the commit body is already a short, well-written description.
- **Not acceptable**: multi-commit branches (concatenates every commit body → long, noisy description; violates Hard Rule #3).
- `--fill-commit-body` modifies behavior to include bodies — avoid on multi-commit branches.

### If you forgot `--squash-before-merge`

```bash
glab mr update <id|branch> --squash-before-merge
```

The `--squash-before-merge` flag on `update` **toggles** the setting. Check current state first with `glab mr view <id> -F json | jq .squash`.

## View — `glab mr view`

```bash
glab mr view <id|branch>                    # Title, body, metadata
glab mr view <id|branch> --comments         # Include threads/notes
glab mr view <id|branch> --system-logs      # Include system activities
glab mr view <id|branch> -F json            # JSON output (scripting)
glab mr view <id|branch> --web              # Open in browser
```

- `-F json` is the canonical way to extract fields programmatically — don't scrape text output
- `--comments` outputs threaded notes; combine with `-F json` for structured access
- Use `--per-page` / `--page` to paginate long comment histories

## Diff — `glab mr diff`

```bash
glab mr diff <id|branch>                    # Show diff
glab mr diff <id|branch> --web              # Open in browser
```

Pipe to a pager if the diff is large: `glab mr diff 123 | less -R`.

## Checkout — `glab mr checkout`

Pulls the MR's source branch into your local working copy so you can test changes.

```bash
glab mr checkout <id|branch|url>
glab mr checkout 12 --branch todo-fix            # Local branch name override
glab mr checkout new-feature --set-upstream-to=upstream/main
```

**Warning**: this changes your working copy. Commit/stash first.

## List — `glab mr list`

```bash
glab mr list --assignee=@me
glab mr list --reviewer=@me --not-draft
glab mr list --author username --state opened
glab mr list --label needs-review --not-label blocked
glab mr list --source-branch feature-x
glab mr list --search "rate limit"
glab mr list -M --per-page 10                # -M = merged only
glab mr list -A                              # --all (open + closed + merged)
glab mr list --draft                         # only drafts
glab mr list -F json                         # scripting
```

Sort/order:
```bash
glab mr list --order updated_at --sort desc
```

Order fields: `created_at`, `updated_at`, `merged_at`, `title`, `priority`, `label_priority`, `milestone_due`, `popularity`.

## Rebase — `glab mr rebase`

Rebases the MR's source branch onto the target branch **on the server**.

```bash
glab mr rebase <id|branch>
glab mr rebase <id|branch> --skip-ci          # Don't trigger pipeline
```

- Requires push permission on the source branch (otherwise 403)
- For conflicts, rebase locally instead — `git checkout <branch> && git rebase <target> && git push --force-with-lease`
- Server-side rebase will silently fail (or report error) on conflicts — verify with `glab mr view` after

## Update — `glab mr update`

Post-create edits. All flags optional; omit what you don't want to change.

```bash
glab mr update <id|branch> -t "New title"
glab mr update <id|branch> -d "New description"
glab mr update <id|branch> -d -                       # Open editor
glab mr update <id|branch> --ready                    # Mark ready (un-draft)
glab mr update <id|branch> --draft                    # Mark draft
glab mr update <id|branch> --squash-before-merge      # Toggle squash (verify state after)
glab mr update <id|branch> --remove-source-branch     # Toggle source-branch removal
glab mr update <id|branch> -a +username               # Add assignee
glab mr update <id|branch> -a -username               # Remove assignee
glab mr update <id|branch> --reviewer +u1,+u2         # Add reviewers
glab mr update <id|branch> -l new-label -u old-label  # Add/remove labels
glab mr update <id|branch> -m "Milestone title"       # Assign milestone
glab mr update <id|branch> -m ""                      # Unassign milestone
glab mr update <id|branch> --lock-discussion
glab mr update <id|branch> --unlock-discussion
```

### Assignee/reviewer prefix semantics

- `+username` — add
- `-username` or `!username` — remove
- `username` (no prefix) — **replace** existing list

## Close / Reopen

```bash
glab mr close <id|branch>
glab mr reopen <id|branch>
```

## Merge — BLOCKED

`glab mr merge` is blocked by Hard Rule #1 and by OpenCode permission. The agent reports "ready to merge" and stops. See `SKILL.md` → Hard Rules.

## End-to-end flow

```bash
# 1. Create feature branch locally
git checkout -b feature/rate-limiting
# ... make commits ...
git push -u origin feature/rate-limiting

# 2. Create MR (canonical form)
REVIEWERS=$(<skill dir>/scripts/resolve_codeowners.py)
glab mr create \
  --squash-before-merge \
  --remove-source-branch \
  ${REVIEWERS:+--reviewer "$REVIEWERS"} \
  -t "Add rate limiting to /api/login" \
  -d "## Decisions
IP-based rate limiting on /api/login, 5 req/min. IP chosen over user-id because abuse hits unauthenticated requests.

## System impact
Adds Redis dependency on the auth path. Shared-NAT users may see 429s under sustained traffic — flagged in SEC-1234." \
  --yes

# 3. Iterate on review feedback
# ... push more commits ...
git push

# 4. Once green and approved:
glab mr view <id> --comments        # confirm threads resolved
glab mr view <id> -F json | jq '.pipeline.status, .approvals_before_merge'

# 5. Hand off to user
echo "MR !<id> ready to merge. Not running glab mr merge — human action required."
```
