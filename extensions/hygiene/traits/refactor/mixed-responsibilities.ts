import type { Trait } from "../../traits.ts";

export default {
  name: "refactor/mixed-responsibilities",
  version: 1,
  subject: "A long function, shown in full.",
  requirement:
    "A function should own one recognizable responsibility. Do not mix unrelated stages such as parsing, decisions, I/O, persistence and presentation in one body without visible phases; separate deciding what should happen from performing the effects.",
  purpose: "Mixed responsibilities make each change touch unrelated logic.",
  candidate: "function-long",
  check: "clef",
  category: "simplicity",
  probabilityThreshold: 0.6,
  severity: "warning",
  fix: "Split `{name}` so deciding and performing are separate, or give each stage its own function.",
  body: "Passes: a long function that runs one sequence of clearly separated stages, a top-level orchestrator that only calls named steps.",
} satisfies Trait;
