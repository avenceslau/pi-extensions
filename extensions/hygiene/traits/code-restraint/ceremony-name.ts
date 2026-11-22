import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/ceremony-name",
  version: 2,
  subject: "New type, class and function names.",
  requirement:
    "Avoid ceremony suffixes such as Factory, Manager, Helper, Util, Wrapper and Impl that describe a pattern instead of what the thing does.",
  purpose: "The suffix hides the responsibility.",
  candidate: "identifier",
  check: "local",
  category: "naming",
  severity: "warning",
  fix: "Rename `{name}` after the thing it produces or the responsibility it owns, so no comment is needed to explain it.",
} satisfies Trait;
