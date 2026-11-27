# Help the user address review comments

Reviewers commented on the user's merge request. The user decides how to answer; you prepare.

1. Read each thread listed in the task, marked `(new)` where the user has not seen it, and the code it refers to.
2. For each thread, write a short summary: what the reviewer asks, whether you agree, and the change you would make.
   Group threads that ask for the same change.
3. Do not edit, commit, push, or comment yet. Present the summaries and wait for the user.
4. When the user tells you what to do, make the changes, run the checks that cover them, and commit. Push with
   `push_branch` and reply with `post_comment` only when the user asks; both ask the user to confirm.
