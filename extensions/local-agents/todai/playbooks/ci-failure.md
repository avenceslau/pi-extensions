# Investigate a CI failure

A CI job failed. Decide whether it is a flaky failure or a real one, and fix flaky ones.

1. Read the log in the task. Use the read-only `glab`/`gh` commands to look at the job, its retries, and other recent
   runs of the same job on the default branch.
2. Classify the failure:
   - **Flaky**: the same code passed on a retry or in another pipeline, or the error comes from timing, ordering,
     shared state, resource limits, the network, or infrastructure rather than the change under test.
   - **Real**: the change under test broke it. It fails consistently on that commit and the error points at the
     change.
3. For a flaky failure, find the root cause in the test, the code under test, or the CI configuration, and fix it on
   the worktree's branch, which starts at the default branch. Do not paper over it with retries, longer timeouts, or
   skipped tests unless the cause is outside the repository, and say so when you do. Run the affected tests several
   times to show the fix holds, commit, and open a merge request with `open_merge_request`; the user must confirm it.
4. For a real failure, do not change code. Explain what broke, on which merge request, and how to fix it.
5. For an infrastructure failure (runner lost, registry down, out of disk), report it with the evidence and stop.
