# Refactoring Patterns

Choose a pattern from the code's symptom. Do not apply patterns speculatively.

| Symptom                             | First move                       | Stop when                      |
| ----------------------------------- | -------------------------------- | ------------------------------ |
| Deep nesting                        | Invert conditions and add guards | The primary path is linear     |
| Repeated discriminator              | Split variants at the boundary   | Each variant is straight-line  |
| Dense expression                    | Name a local value               | Intent is obvious in place     |
| Mixed decisions and effects         | Compute, then perform            | Side effects are explicit      |
| Optional-field or flag combinations | Model explicit states            | Invalid combinations disappear |
| Mixed processing stages             | Reorder and add whitespace       | The stages are visually clear  |

## Flatten control flow

Before extracting code:

- Handle invalid, exceptional, and terminal cases with guard clauses, early returns, or early throws.
- Use `continue` to keep loop bodies shallow.
- Normalize inputs once and remove conditions made redundant by the new flow.
- Split structurally different variants once near the boundary instead of checking the same discriminator throughout the implementation.

After flattening, reassess. Stop if the primary path is easy to scan and responsibilities are clear.

## Clarify locally

Before moving code elsewhere:

- Name a dense condition or expression with a local value when that preserves useful locality.
- Arrange code into visible phases: guards, normalization, decisions or construction, side effects, and return.
- Separate deciding what should happen from performing I/O or mutation.

Use whitespace before extraction. Extract a phase only when it owns a coherent responsibility.

## Extract coherent responsibilities

Do not extract arbitrary lines merely to shorten a function. A useful extraction:

- Describes intent rather than mechanics.
- Has explicit inputs and outputs.
- Owns one recognizable responsibility.
- Improves both its definition and call sites.
- Lives in the layer responsible for the behavior.
- Depends on the narrowest useful interface.

Reuse authoritative domain state and existing project utilities instead of duplicating them.

## Model states explicitly

When flags or optional fields allow contradictory combinations, represent meaningful variants explicitly. Depending on the language, use complete input shapes, tagged unions, enums, or semantic terminal operations.

The goal is to make invalid states difficult or impossible, not to move validation into runtime assertions.

## Choose the smallest abstraction

Prefer, in order:

1. A flattened local implementation
2. A named function
3. A cohesive module
4. A class, strategy, or builder when state or staged construction warrants it

Do not generalize for hypothetical uses. Apply the rule of three to reusable abstractions, not to semantic extraction.

## Builder test

A builder should eliminate branching rather than relocate it into methods. Use one only when:

- Its stages are meaningful to callers.
- Its terminal operations express distinct domain intent.
- It prevents invalid combinations or makes them obvious.
- Multiple real call sites or a strong semantic boundary justify it.
- Its call sites are materially clearer.

Do not add a builder merely because a function accepts several fields. Prefer complete arguments or typed stages over runtime assertions when required state is known at compile time.
