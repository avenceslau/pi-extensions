# Refactoring Safety

## Establish the baseline

Before restructuring non-trivial code:

- Find all call sites and externally visible behavior.
- Identify focused tests, type checks, and repository validation commands.
- Run relevant checks against the existing code when practical.
- Distinguish committed behavior from unrelated work in progress.
- Treat pre-existing failures as part of the baseline.

Keep intentional behavior changes explicit and cover them separately in tests.

## Preserve operational behavior

Return values are not the whole contract. Check whether the refactor changes:

- Side-effect order
- Error types or messages
- Logging or metrics
- Retry behavior
- Transaction boundaries
- Timing or concurrency
- Whether asynchronous work remains awaited

## Protect boundaries

Do not weaken the surrounding design to enable extraction:

- Do not widen private or protected visibility for access convenience.
- Inject required dependencies explicitly.
- Prefer narrow structural interfaces over entire environments or service containers.
- Avoid circular dependencies introduced by moving code.
- Preserve or improve compile-time guarantees.
- Reuse the most authoritative source of state already available.

## Verify the result

Run the focused checks established in the baseline. Confirm that:

- Behavior is preserved, or intentional changes are explicit and tested.
- The primary path is shallower and easier to scan.
- Conditions, mutation, or duplication were reduced rather than hidden.
- Type guarantees, encapsulation, and dependency boundaries did not regress.
- The diff contains no unrelated cleanup.

Line count, file count, and the presence of a design pattern are not evidence of improvement.
