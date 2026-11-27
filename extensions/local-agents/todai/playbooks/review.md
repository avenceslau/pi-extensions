# Report on a merge request's code style

The hygiene linter found too many problems in a merge request by someone else. The team keeps the code base clean, so
the user wants a report they can turn into review comments.

You are read-only: never run the repository's code, scripts, or tests, because they come from someone else.

1. Read the hygiene report in the task and the code around each finding. Drop findings that are wrong in context and
   say why.
2. Add the style problems the linter missed: the code-restraint rules (no comments that restate code, literal names,
   no speculative abstractions or one-use wrappers, shallow control flow, vertical layout) and the repository's own
   conventions from `AGENTS.md` and `CONTRIBUTING.md`.
3. Write the report: a one-paragraph verdict, then the findings grouped by kind, most important first, each with
   `path:line`, the problem, and the fix.
4. Draft the review comments you would post and stop. Post one with `post_comment` only if the user asks; it asks the
   user to confirm.
