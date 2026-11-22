# Review Workflow

Full reference for approving, commenting, and driving review threads on MRs. Always run `glab <cmd> --help` to confirm current flags.

## Approve — `glab mr approve`

```bash
glab mr approve <id|branch>
glab mr approve 235
glab mr approve 123 345                  # Approve multiple
glab mr approve                          # Current branch's open MR
glab mr approve <id> --sha <commit-sha>  # Require HEAD to match
```

- `--sha` guards against approving a moving target — pass the SHA you reviewed. If the branch is force-pushed after, your approval request fails rather than silently approving new code.
- Approval reset policy (MR must be re-approved after new pushes) is a project setting, not a flag. Check with `glab mr view <id> -F json | jq '.approvals_before_merge'`.

## Revoke approval — `glab mr revoke`

```bash
glab mr revoke <id|branch>
glab mr revoke                           # Current branch
```

Use when you've approved then found an issue, or when approval was based on since-superseded code.

## Comment / Note — `glab mr note`

```bash
glab mr note <id|branch> -m "Comment text"
glab mr note <id|branch>                           # Opens editor for multi-line
glab mr note <id|branch> -m "LGTM" --unique        # Skip if identical note exists
glab mr note                                       # Current branch's open MR
```

- `--unique` is idempotent-friendly — re-running a script won't spam the thread.
- For multi-line comments, either use `-m "$(cat <<'EOF'...EOF)"` or invoke without `-m` to open your `$EDITOR`.

### Suggestion blocks

GitLab renders fenced `suggestion` blocks inline on diffs. Include them in a note:

````markdown
Replace the loop guard with an explicit bounds check:

```suggestion:-0+0
if (i >= items.length) break;
```
````

- Range format: `suggestion:-<lines-before>+<lines-after>` relative to the line the comment is anchored to.
- The `glab mr note` command creates a **general MR comment**, not a positional diff comment. To anchor a suggestion to a specific diff line, you need GitLab's discussion API (`glab api`) — see "Positional / threaded comments" below.

### Positional / threaded comments (API fallback)

`glab mr note` creates a top-level general comment. For **diff-anchored threaded comments** (the kind that show up inline in the file view), use `glab api`:

```bash
# Create a discussion anchored to a specific line (simplified)
glab api -X POST \
  "projects/:fullpath:/merge_requests/<iid>/discussions" \
  -f body="Issue on this line." \
  -f position[position_type]=text \
  -f position[new_path]=path/to/file.ts \
  -f position[new_line]=42 \
  -f position[base_sha]=<base_sha> \
  -f position[head_sha]=<head_sha> \
  -f position[start_sha]=<start_sha>
```

Retrieve `base_sha`, `head_sha`, `start_sha` from `glab mr view <id> -F json | jq '.diff_refs'`.

**This is a thin fallback — consult the current GitLab API reference before using in scripts**:
https://docs.gitlab.com/api/discussions/

## Thread resolution

`glab` has no first-class thread-resolve command. Use `glab api`:

```bash
# Resolve a discussion
glab api -X PUT \
  "projects/:fullpath:/merge_requests/<iid>/discussions/<discussion_id>?resolved=true"
```

Get discussion IDs from `glab mr view <id> -F json --comments` or the discussions endpoint.

## To-do items — `glab mr todo`

```bash
glab mr todo <id|branch>
```

Adds the MR to your personal to-do list in GitLab. Useful for "come back to this later" without leaving a public comment.

## Subscribe / Unsubscribe

```bash
glab mr subscribe <id|branch>
glab mr unsubscribe <id|branch>
```

Controls whether you receive notifications for MR events.

## Review etiquette checklist

Before **approving** an MR:

- [ ] Pipeline is green (`glab mr view <id> -F json | jq '.pipeline.status'`)
- [ ] Description follows the short, decision-focused template (`## Decisions` / `## System impact`, ≤10 lines). If it's missing decisions, restates the diff, or runs long, request a rewrite via `glab mr note` before approving.
- [ ] `squash-before-merge` is enabled (`glab mr view <id> -F json | jq '.squash'`). If `false`, request the author enable it: `glab mr update <id> --squash-before-merge`.
- [ ] Diff reviewed — either `glab mr diff <id>` or `glab mr checkout <id>` for local testing
- [ ] Open threads are addressed / resolved
- [ ] You've confirmed the HEAD SHA you reviewed matches approval (`glab mr approve <id> --sha <sha>` if you want to pin it)

Before **leaving review feedback**:

- [ ] Be specific: file + line number or a quote from the code
- [ ] Distinguish blocking (`request changes`) from nit (`style/nit:` prefix)
- [ ] Use suggestion blocks when proposing exact code replacements

After review, **stop at "ready to merge"**. Do not run `glab mr merge` (Hard Rule #1).

## What `glab` does not handle well

| Need                              | Workaround                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------- |
| Diff-anchored positional comments | `glab api` to `/merge_requests/<iid>/discussions` with `position[...]` fields |
| Resolving threads                 | `glab api -X PUT .../discussions/<id>?resolved=true`                          |
| Replying within a thread          | `glab api -X POST .../discussions/<discussion_id>/notes`                      |
| Merging                           | **Don't** — Hard Rule #1                                                      |

When you find yourself reaching for `glab api`, fetch the GitLab API docs first:
https://docs.gitlab.com/api/merge_requests/
https://docs.gitlab.com/api/discussions/
