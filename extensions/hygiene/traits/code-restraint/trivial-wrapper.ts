import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/trivial-wrapper",
  version: 1,
  subject:
    "A newly added function whose body is a single call or a single returned expression.",
  requirement:
    "Do not add a wrapper that only forwards to another function or renames one operation without adding a meaningful default, type narrowing, error mapping or boundary.",
  purpose:
    "A wrapper that adds nothing is one more name to learn and one more hop to follow.",
  candidate: "function-single-statement",
  check: "clef",
  category: "simplicity",
  probabilityThreshold: 0.6,
  severity: "info",
  fix: "Call the wrapped function directly and delete `{name}`.",
  alternate:
    "Look at function `{name}` in candidate {candidate}. If a reader deleted it and called what it calls directly, would the code lose anything (a default, a type, error handling, a name many callers share)? Answer true if nothing would be lost.",
  body: [
    "Passes: wrappers that bind a required argument used at many call sites, adapt a type at an API boundary, or are required by an interface.",
    "Fails: `function getUser(id) { return db.getUser(id) }`.",
  ].join("\n"),
} satisfies Trait;
