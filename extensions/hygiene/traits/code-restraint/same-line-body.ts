import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/same-line-body",
  version: 1,
  subject: "JavaScript or TypeScript if, else, for, while and do statements.",
  requirement: "Never put a control-flow body on the same line as its header; always brace the body and put it on its own line.",
  purpose: "One-line bodies hide control flow when scanning.",
  candidate: "control-statement",
  check: "local",
  category: "layout",
  severity: "warning",
  fix: "Brace the body and move it to its own line.",
} satisfies Trait;
