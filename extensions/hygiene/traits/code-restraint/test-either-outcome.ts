import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/test-either-outcome",
  version: 1,
  subject: "A test case body that contains an if, try/catch, .catch or expect.anything branch.",
  requirement: "A test asserts one exact outcome. It must not branch so that either result passes.",
  purpose: "A test that passes both ways tests nothing.",
  candidate: "test-branch",
  check: "clef",
  category: "simplicity",
  probabilityThreshold: 0.7,
  severity: "warning",
  fix: "Assert the one expected outcome and remove the branch.",
} satisfies Trait;
