import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/generic-name",
  version: 1,
  subject: "New function, variable, constant, parameter and type names.",
  requirement: "A name must not be a placeholder such as data, info, result, value, item, obj, tmp, thing, stuff, payload, handle, process, helper, flag or list, alone or with filler words (newValue, doStuff, processData). A constant holding a time, size, rate or count, such as TIMEOUT, DELAY, INTERVAL, LIMIT, SIZE, MAX or TTL, must carry its unit (TIMEOUT_MS, MAX_BODY_BYTES, retryDelaySeconds). A boolean must read as a yes-or-no question (isReady, hasLease, shouldRetry) or an adjective or participle (enabled, visible).",
  purpose: "A reader should know what a name holds without reading the code around it or a comment.",
  candidate: "identifier",
  check: "local",
  category: "naming",
  severity: "warning",
  fix: "Rename `{name}` after what it holds or does, with its unit or as a yes-or-no question, so no comment is needed to explain it.",
  body: "Loop variables, catch bindings, inline callback and setter parameters, destructured names that keep their property's name, and properties are exempt; names of one or two characters belong to short-name.",
} satisfies Trait;
