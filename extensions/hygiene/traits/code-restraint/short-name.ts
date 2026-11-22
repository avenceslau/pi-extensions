import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/short-name",
  version: 2,
  subject: "New variable, parameter and function names.",
  requirement:
    "Names of one or two characters are allowed only for loop counters (i, j, k), the discard name `_`, and conventional short words (id, ok, db, fs, io, ms, fn, to, at, op).",
  purpose: "Short names force the reader to look up the declaration.",
  candidate: "identifier",
  check: "local",
  category: "naming",
  severity: "warning",
  fix: "Rename `{name}` to say what it holds, so no comment is needed to explain it.",
} satisfies Trait;
