# Rebase the user's merge request

The user's merge request has conflicts with its target branch. Rebase it and push it without asking, unless the
rebase needs a decision only the user can make.

1. Fetch the target branch and rebase the worktree's branch onto it.
2. Resolve each conflict by keeping the intent of both sides. Read the merge request description and the target
   branch's commits that caused the conflict when the intent is unclear.
3. Run the checks that cover the files you touched: the type check, linter, and tests of the affected packages.
4. Push with `push_branch`. It refuses if someone pushed to the branch since this task started; then stop and tell the
   user.

Stop before pushing and explain the choice to the user when any of these holds:

- Both sides changed the same behaviour in incompatible ways and the right result is not clear from the code.
- Resolving the conflict means rewriting logic rather than combining changes.
- The checks fail after the rebase and the failure is not a direct, mechanical consequence of the conflict.
- The rebase touches more than a handful of conflicting files.
