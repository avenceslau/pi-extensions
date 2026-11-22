import type { Trait } from "../../traits.ts";

export default {
  name: "refactor/duplication",
  version: 1,
  subject: "Added code across all files in the change.",
  requirement:
    "Do not copy the same block of five or more lines into several places in the change; reuse one definition. Lines match when they differ only in names and literals.",
  purpose:
    "A change to the duplicated logic must otherwise be made in every copy.",
  candidate: "token-shingles",
  check: "local",
  category: "simplicity",
  sizeThreshold: 5,
  severity: "warning",
  fix: "Keep one copy and call it from both places.",
} satisfies Trait;
