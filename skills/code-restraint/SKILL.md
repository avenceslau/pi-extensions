---
name: code-restraint
description: Mandatory rules for any code-writing or editing task. Load before starting to write or edit code, and again before finishing as a self-review checklist. Enforces minimal comments, real-vocabulary naming, shallow control flow, and restraint against premature abstraction or trivial wrappers.
license: MIT
compatibility: opencode
---

## Comment rules

- Do not add comments that only restate what the code does.
- Add a comment only when it explains _why_, captures a non-obvious invariant or constraint, documents tricky business logic, or warns about a gotcha.
- Keep doc comments on exported / public API symbols where the project convention requires them.

## Naming and vocabulary rules

- Every function name, variable name, type name, and comment must describe literally what the thing is or does, in plain words.
- Never invent metaphors, jargon, or coined terms for a mechanism. A cron run is not an "incarnation", a restarted job is not a "resurrection", a pending timer is not an "arm".
- Existing invented terms in the codebase are not precedent. Do not follow, reuse, or extend them; describe the thing literally even if the surrounding code does not. Copying a made-up term spreads it.
- A reader who has never seen the codebase must understand a name without a glossary. If a name needs a comment to explain what the word means, the name is wrong.
- Do not coin abbreviations or compressed phrases. Spell out the real words.

## Abstraction rules

- Do not extract a helper, wrapper, or class solely to shorten a function or rename a single operation.
- A one-use extraction is justified only when it creates a coherent semantic boundary or materially reduces otherwise unavoidable nesting or complexity.
- Apply the rule of three to reusable generalizations: abstract on the third real use site, not the first or second.
- Do not introduce config knobs, hooks, plugins, or generics for hypothetical future needs.

## Control flow and nesting

- Keep the primary path shallow and visually direct.
- When control flow is deeply nested, first invert conditions and use guard clauses, early returns, early throws, or `continue` where appropriate.
- Reassess after flattening. Extract code only if meaningful complexity remains and the extraction owns a coherent responsibility.
- Do not invert a condition when it creates a confusing double negative.

## Readability and vertical formatting

- Favor vertical layout over horizontal compression. Do not pack several logical fields, conditions, or arguments onto one line merely because they fit within the formatter's line limit.
- Put multi-clause boolean conditions on multiple lines, with the grouped clauses visually apparent.
- Expand nested object literals and objects with three or more meaningful fields so each field has its own line.
- Expand function and constructor calls with multiple substantial arguments so each argument has its own line.
- Break dense function signatures across lines when the parameters and return type compete for horizontal space.
- Use blank lines to separate logical stages such as guard clauses, validation, construction, side effects, and the final return. Do not collapse those stages into an uninterrupted wall of code.
- Treat formatter compliance as a minimum, not a readability test. Inspect the formatted result and preserve a scannable vertical structure without formatter-ignore directives or noise comments.

## JavaScript / TypeScript control flow

- Never put a control-flow body on the same line as its header. Always brace the body and put it on its own line — for every `if`, `else`, `for`, `while`, and `do`, no matter what the body is (return, throw, continue, break, a call, an assignment).

```js
// Bad
if (condition) doThing()
if (condition) return
for (const x of xs) process(x)
while (running) tick()

// Good
if (condition) {
  doThing()
}

for (const x of xs) {
  process(x)
}
```

## Editing diffs

- Do not opportunistically add comments or wrappers unrelated to the change being made.
- When reviewing AI-authored diffs, strip noise comments and trivial wrappers, and rename any invented vocabulary to literal, existing terms.
