import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/undescriptive-name",
  version: 1,
  subject: "A newly declared function, method, constant, variable, parameter or type name, shown with the code that declares it and the added lines that use it.",
  requirement: "The name alone must tell a reader what the thing holds or does, without the surrounding code or a comment. A function or method name must be a verb phrase naming its effect or the result it returns (parseDiff, countAddedLines, buildExcerpt). A value's name must say what it is, with its unit when it is a quantity. Vague words that fit many things (manager, process, handle, check, do, run, info, data, state, stuff), names that need a comment to explain them, and names that say less than the code makes obvious break the rule.",
  purpose: "Names are the documentation readers actually read; a vague name forces them into the body or a comment.",
  candidate: "identifier",
  check: "clef",
  category: "naming",
  probabilityThreshold: 0.85,
  severity: "warning",
  fix: "Rename `{name}` so the name alone says what it holds or does, and no comment is needed to explain it.",
  body: [
    "Passes: retryDelayMs, parseHunkHeader, pendingLeases, isExpired, UserSession.",
    "Fails: check() for a function that validates a token, process() for one that writes rows, a `state` that holds only a cursor, a `count` of something the name does not say, `run` for a function that uploads files.",
    "Invented metaphors belong to coined-name and placeholders such as data or tmp to generic-name.",
  ].join("\n"),
} satisfies Trait;
