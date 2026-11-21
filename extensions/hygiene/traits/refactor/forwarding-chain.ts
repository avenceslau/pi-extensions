import type { Trait } from "../../traits.ts";

export default {
  name: "refactor/forwarding-chain",
  version: 1,
  subject: "Functions whose body is a single call to another function.",
  requirement: "Do not chain functions that only forward to the next one; two or more hops that add nothing should collapse into one.",
  purpose: "Complexity moved behind another name is still complexity.",
  candidate: "function-single-statement",
  check: "local",
  category: "simplicity",
  severity: "warning",
  fix: "Call `{target}` directly and delete the forwarding function `{name}`.",
} satisfies Trait;
