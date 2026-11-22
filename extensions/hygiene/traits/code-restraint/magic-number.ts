import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/magic-number",
  version: 1,
  subject: "Numeric literals in expressions, outside test files.",
  requirement:
    "Do not use an unnamed numeric literal other than 0, 1 and -1, or 2 when doubling or halving. A literal is named when it is the value of a constant, an enum member, a property, a parameter default or a type. Indexes and slice offsets belong to magic-offset.",
  purpose:
    "A bare number hides what it means and its unit, and copies of it drift apart.",
  candidate: "numeric-literal",
  check: "local",
  category: "simplicity",
  severity: "warning",
  fix: "Move the number into a constant whose name says what it is and its unit, such as RETRY_DELAY_MS or MAX_BODY_BYTES.",
} satisfies Trait;
