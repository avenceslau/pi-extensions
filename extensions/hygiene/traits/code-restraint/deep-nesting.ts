import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/deep-nesting",
  version: 1,
  subject: "Control flow inside a function.",
  requirement: "Keep the primary path shallow. Control flow nested four or more levels deep inside one function should be flattened with guard clauses, early returns, early throws or continue.",
  purpose: "Each level of nesting is one more condition the reader must hold.",
  candidate: "function",
  check: "local",
  category: "nesting",
  sizeThreshold: 4,
  severity: "warning",
  fix: "Invert the outer conditions into guard clauses or early returns so the primary path is at most three levels deep.",
} satisfies Trait;
