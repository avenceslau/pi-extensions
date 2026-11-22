import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/speculative-knob",
  version: 1,
  subject:
    "A newly added option, optional parameter, default parameter, config key, hook or generic type parameter, shown with the code that declares and uses it.",
  requirement:
    "Do not introduce config knobs, options, hooks, plugins or generics for hypothetical future needs. An option is justified only when a current caller passes a value other than the default or a current requirement needs it.",
  purpose: "Every knob doubles the states to test and reason about.",
  candidate: "knob",
  check: "clef",
  category: "simplicity",
  probabilityThreshold: 0.6,
  severity: "warning",
  fix: "Remove `{name}` and use the one value callers need today.",
  body: "Fails: an `options` object with one field nobody sets, a `strategy` parameter with one implementation, a timeout parameter only ever passed its default.",
} satisfies Trait;
