import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/coined-name",
  version: 2,
  subject: "A newly declared name (function, type, variable, constant, property or SQL alias), shown with the code that declares it and the added lines that use it.",
  requirement: 'The name must describe literally what the thing is or does in plain words. It must not be an invented metaphor, jargon, coined term or compressed abbreviation that needs a glossary, such as calling a cron run an "incarnation", a restarted job a "resurrection" or a pending timer an "arm".',
  purpose: "A reader who has never seen the codebase must understand the name without a glossary.",
  candidate: "identifier",
  check: "clef",
  category: "naming",
  probabilityThreshold: 0.6,
  severity: "warning",
  fix: "Rename `{name}` to a literal description of what it holds or does, so no comment is needed to explain it.",
  body: [
    "Passes: domain terms that already exist outside this code (lease, semaphore, alarm, retry, backoff), standard abbreviations (id, url, http, sql, ms).",
    "Fails: metaphors (floor, ghost, heartbeat for something that is not one), invented compounds, unexplained acronyms.",
  ].join("\n"),
} satisfies Trait;
