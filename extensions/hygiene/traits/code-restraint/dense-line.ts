import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/dense-line",
  version: 1,
  subject: "A single line holding a multi-clause boolean condition, an object literal with three or more fields, or a call with three or more substantial arguments.",
  requirement: "Put multi-clause conditions, three-field object literals and multi-argument calls on multiple lines.",
  purpose: "Vertical layout is easier to scan.",
  candidate: "line",
  check: "local",
  category: "layout",
  severity: "info",
  fix: "Put each clause, field or argument on its own line.",
  skipWhenFormatted: true,
  body: "Formatter-owned: when the repository has a formatter (prettier, biome, oxfmt, rustfmt) it may rewrite these lines, so findings are reported at info level and never block.",
} satisfies Trait;
