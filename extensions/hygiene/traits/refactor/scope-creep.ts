import type { Trait } from "../../traits.ts";

export default {
  name: "refactor/scope-creep",
  version: 1,
  subject: "The whole change against its stated purpose.",
  requirement: "A change should do one thing; separable changes belong in separate reviews.",
  purpose: "Mixed reviews hide risk.",
  candidate: "change",
  check: "llm",
  category: "simplicity",
  severity: "warning",
  fix: "Split the separable changes into their own commits or reviews.",
  body: "Needs the PR title and description and a whole-change view; kept on the LLM reviewer.",
} satisfies Trait;
