import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/one-use-helper",
  version: 1,
  subject: "A newly added function that the code calls from exactly one place, shown with its body. The number of call sites was counted by the linter and is given.",
  requirement: "A one-use helper is justified only when it creates a coherent semantic boundary (a named, self-contained responsibility with explicit inputs and outputs) or materially reduces otherwise unavoidable nesting or complexity. Do not extract a helper only to shorten a function or to rename a single operation.",
  purpose: "Extra hops cost readers more than the lines they save.",
  candidate: "function-one-use",
  check: "clef",
  category: "simplicity",
  probabilityThreshold: 0.6,
  severity: "info",
  fix: "Inline `{name}` at its only call site.",
  alternate: "Function `{name}` in candidate {candidate} is called from one place. Would inlining it at that call site make the code as clear or clearer? Answer true if yes.",
  body: [
    "Passes: a function that owns a whole step such as parsing, validation, a protocol exchange or a storage transaction; a callback that must be a named function.",
    "Fails: a two- or three-line function that wraps one call or one expression and is used once.",
  ].join("\n"),
} satisfies Trait;
