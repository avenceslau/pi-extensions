import type { Trait } from "../../traits.ts";

export default {
  name: "refactor/tangled-branching",
  version: 1,
  subject:
    "A function with many branches, shown in full. The branch count was computed by the linter and is given.",
  requirement:
    "Branching must be easy to follow: do not check the same discriminator repeatedly throughout a function, interleave unrelated conditions, or allow contradictory flag combinations. Split structurally different variants once at the boundary, use guard clauses, or model explicit states.",
  purpose: "Tangled branching hides which combinations are possible.",
  candidate: "function-branchy",
  check: "clef",
  category: "nesting",
  probabilityThreshold: 0.6,
  severity: "warning",
  fix: "Split `{name}` by variant at the top, or turn the flag combinations into explicit states.",
  body: "Passes: a flat switch over one discriminator, a sequence of independent guard clauses.",
} satisfies Trait;
