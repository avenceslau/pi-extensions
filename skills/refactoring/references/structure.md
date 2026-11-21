# File Structure

A directory listing should show the package's primitives, not every file that implements them.

## One folder per primitive

When a package exposes several primitives (features, components, bindings, or services), give each primitive its own folder. Put its implementation, protocol, store, client, server, errors, and unit tests together.

Bad: durability's flat `src/`, where a shared filename prefix is the only grouping:

```text
src/semaphore.ts
src/semaphore-client.ts
src/semaphore-leases.ts
src/semaphore-protocol.ts
src/semaphore-queue.ts
src/semaphore-queue-store.ts
src/semaphore-server.ts
src/semaphore-store.ts
src/semaphore.test.ts
src/topology.ts
src/topology-client.ts
src/topology-snapshot.ts
```

Good: miniflare's `src/plugins/`, one folder per binding with the same file names in each, and a `shared/` folder for code every binding uses:

```text
src/plugins/kv/index.ts
src/plugins/kv/constants.ts
src/plugins/kv/sites.ts
src/plugins/queues/index.ts
src/plugins/queues/errors.ts
src/plugins/d1/index.ts
src/plugins/r2/index.ts
src/plugins/shared/index.ts
src/plugins/shared/constants.ts
src/plugins/shared/routing.ts
```

Applied to durability, that gives `src/semaphore/{index,client,leases,protocol,queue,queue-store,server,store}.ts` and `src/topology/{index,client,snapshot}.ts`.

## Signals that a folder is missing

- Two or more files share a primitive-name prefix, in any casing: `semaphore-*.ts`, `semaphore_*.ts`, or camelCase `rateLimit*.ts`.
- A new primitive arrives as files placed directly in an existing flat directory.
- One primitive is split across packages or sibling directories with nothing grouping it. For example, `rateLimit.ts`, `rateLimitInspection.ts`, and `rateLimitWaiters.ts` in `apps/server/src/lib/`, plus `rateLimitConfig.ts`, `rateLimitKeys.ts`, and `rateLimitKillSwitch.ts` in `packages/shared/src/`.
- Tests, workers, or fixtures for one primitive are spread across sibling directories.

## Group by primitive, not by layer

Folders named after technical layers spread one primitive across the tree, so every change to it touches several folders.

Bad: `sandbox-sdk/packages/sandbox-container/src/`:

```text
handlers/git-handler.ts       services/git-service.ts       managers/git-manager.ts
handlers/file-handler.ts      services/file-service.ts      managers/file-manager.ts
handlers/process-handler.ts   services/process-service.ts   managers/process-manager.ts
```

Good:

```text
git/handler.ts       git/service.ts       git/manager.ts
file/handler.ts      file/service.ts      file/manager.ts
process/handler.ts   process/service.ts   process/manager.ts
```

Flag `handlers/`, `services/`, `managers/`, `controllers/`, `stores/`, or `clients/` trees when the same primitive name repeats across them. Also flag suffixes that repeat the folder name, such as `handlers/git-handler.ts`.

## Catch-all folders

`lib/`, `utils/`, `helpers/`, `shared/`, and `common/` are for small cross-cutting helpers. Flag them when they hold whole primitives or keep growing without structure. For example, an `apps/server/src/lib/` that mixes semaphores, a priority queue, rate limiting, and cron registration across 19 files. Move each primitive into its own folder and keep only genuinely shared helpers behind.

## Acceptable layouts

- **Splits along runtime or build boundaries.** Miniflare keeps `src/plugins/kv/` (Node) separate from `src/workers/kv/` (`*.worker.ts`, bundled for workerd). Splitting one primitive across two roots is fine when the roots match how the code is built or where it runs, and each root is itself grouped by primitive.
- **Flat directories of uniform single-file items.** A `packages/db/src/stores/` directory holding about 20 `<table>.store.ts` files, each with only its spec beside it. That stays flat until one store needs a second implementation file.
- **One file per variant inside a concept folder.** A job runner's `src/steps/` has `run.ts`, `sleep.ts`, `waitForEvent.ts`, and `runner.ts`, one file per step type.

## Rules

- Drop the redundant prefix or suffix inside the folder: `semaphore/client.ts`, not `semaphore/semaphore-client.ts`; `git/handler.ts`, not `git/git-handler.ts`.
- Use the same file names across sibling primitive folders (`index.ts`, `client.ts`, `errors.ts`, `constants.ts`) so each folder reads the same way.
- Keep code used by several primitives, such as storage, serialization, errors, and the scheduler, in one shared location. Do not copy it into each folder.
- A primitive that is a single small file can stay a file. Create the folder when it gains a second file.
- Integration tests and their worker fixtures can follow the same grouping, such as `tests/semaphore/`, when the test directory is also flat.
- Preserve the public API. Package `exports`, build entry points, and `tsconfig` includes must still resolve after files move. Re-export from `index.ts` instead of changing import paths that consumers use.
- Move files in their own commit, separate from behavior changes, so the diff reads as renames.
- Do not create folders that hold only one file and are not expected to grow, and do not add layered nesting such as `src/primitives/semaphore/impl/`.

## Reviewing a diff

- If the diff adds a file to a flat prefix cluster, a layer folder, or a catch-all folder, or introduces a new primitive as loose files, report it and name the target folder and file names.
- If the diff creates the bad layout, report it at medium severity. If the layout already existed, mention the restructure as a separate follow-up instead of blocking the change.
