---
name: refactoring
description: Refactor existing code to reduce nesting, branching, duplication, and cognitive complexity while preserving behavior. Load when asked to refactor, simplify, clean up, flatten control flow, extract responsibilities, or make difficult code easier to read.
license: MIT
compatibility: Language-agnostic. Follow repository-specific conventions.
---

# Refactoring

Refactor toward the underlying readability or ownership problem, not a requested mechanism. Moving code is not the same as simplifying it.

Apply the `code-restraint` skill throughout.

## Workflow

Follow this order:

1. **Establish the baseline.** Find call sites, behavior, focused tests, and type checks.
2. **Name the problem.** Identify nesting, repeated conditions, mixed responsibilities, unclear ownership, mutation, or difficult data flow.
3. **Get approval.** Present the proposed refactors and wait for the user's explicit approval before modifying code. If the intended scope changes, request approval again.
4. **Invert and flatten.** Simplify control flow before moving code.
5. **Reassess.** Stop if the flattened implementation is clear.
6. **Extract.** Isolate a coherent responsibility only when meaningful complexity remains.
7. **Abstract cautiously.** Add a class, strategy, or builder only when it removes complexity.
8. **Verify.** Compare behavior, readability, types, and boundaries before and after.

Keep structural and intentional behavioral changes distinguishable.

## Core rules

- Prefer a shallow primary path using guard clauses, early returns, early throws, and `continue`.
- Do not invert conditions into confusing double negatives.
- Extraction and generalization are different. A one-use extraction is valid when it creates a meaningful boundary or materially reduces unavoidable complexity.
- Do not replace nesting with tiny forwarding helpers.
- Choose the smallest abstraction that makes both the definition and call sites clearer.
- Do not weaken type guarantees, encapsulation, or dependency boundaries to enable extraction.
- Complexity moved behind another name is still complexity.
- Group files by primitive, not by layer. When several files share a primitive-name prefix, such as `semaphore-*.ts` or `rateLimit*.ts`, or one primitive repeats across `handlers/`, `services/`, and `managers/`, they belong in one folder for that primitive.

## Progressive references

Read only what the task requires:

- Read [patterns.md](references/patterns.md) when flattening, extraction, or abstraction choice is non-trivial.
- Read [structure.md](references/structure.md) when a change adds, moves, or splits files, or when a directory is flat and prefix-named, grouped by layer, or a growing catch-all such as `lib/` or `utils/`.
- Read [safety.md](references/safety.md) when the refactor crosses modules, changes dependencies or types, touches public behavior, or starts from a failing or dirty baseline.
- Read [experimental.md](references/experimental.md) when a risky refactor needs a parallel implementation, shadow execution, or A/B comparison.
