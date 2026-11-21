import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/magic-offset",
  version: 1,
  subject: "Indexing and slicing with numeric literals.",
  requirement: "Do not index or slice with an unexplained numeric literal other than 0, 1 or -1, such as `parts[3]` or `line.slice(7)`.",
  purpose: "Magic offsets break silently when the format changes.",
  candidate: "element-access",
  check: "local",
  category: "simplicity",
  severity: "warning",
  fix: "Destructure with names, use a named constant, or derive the offset from the prefix length.",
} satisfies Trait;
