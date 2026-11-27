# Make a CI job faster

A CI job on the default branch is slow or got slower. Find where its time goes and make one change that shortens it.

1. Read the timings in the task, then the job's definition in the CI configuration and the scripts it runs. Use the
   read-only `glab`/`gh` commands to read logs of recent runs and see which steps take the time.
2. Look for the largest saving with the smallest risk, for example: caching dependencies or build output, skipping work
   unrelated to the change, splitting or parallelising tests, removing duplicated setup, a smaller base image, or
   starting the job earlier by fixing its dependencies.
3. Make one focused change on the worktree's branch, which starts at the default branch. Validate it locally where you
   can, and explain how CI should confirm the saving.
4. Open a merge request with `open_merge_request`, stating the expected saving and how you estimated it; the user must
   confirm it.
5. If nothing worthwhile is safe to change, say what you found and stop.

A merge request you open gets auto-merge once its pipeline starts, so it merges as soon as the pipeline passes and
the required approvals are in. Open it only when it is ready to merge as it is.
