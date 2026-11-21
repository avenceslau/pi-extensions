# Experimental Refactoring

Use a parallel implementation when a large or behaviorally risky refactor needs experimentation or A/B comparison. In this case, coexistence with the existing implementation is intentional.

## Parallel implementation pattern

1. Preserve the existing implementation as the behavioral control.
2. Add the alternative behind an explicit selection seam.
3. Run equivalent inputs through both implementations where safe.
4. Compare observable results such as state transitions, persisted state, side effects, errors, and performance.
5. Instrument divergences rather than assuming parity.
6. Keep the experimental path isolated and removable.

The existing path can act as a behavioral oracle while the alternative evolves. Partial implementations and scaffolding are acceptable when they cannot accidentally become the production path.

## Safety

- Do not execute irreversible side effects twice. Suppress, sandbox, or record shadow effects for comparison.
- Make path selection explicit in code, tests, and observability.
- Keep state and input assumptions comparable between both paths.
- Mark unsupported cases so they cannot silently fall through to misleading results.
- Avoid sharing mutable experimental state that could influence the control path.
