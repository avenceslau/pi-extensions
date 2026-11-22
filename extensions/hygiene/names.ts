import type { Identifier } from "./analysis.ts";

const PLACEHOLDER_WORDS = new Set([
  "a",
  "arr",
  "array",
  "b",
  "bar",
  "baz",
  "c",
  "data",
  "datum",
  "dict",
  "elem",
  "element",
  "flag",
  "flags",
  "foo",
  "handle",
  "helper",
  "info",
  "item",
  "items",
  "list",
  "map",
  "misc",
  "num",
  "obj",
  "object",
  "out",
  "payload",
  "process",
  "qux",
  "res",
  "resp",
  "result",
  "results",
  "ret",
  "retval",
  "str",
  "stuff",
  "temp",
  "thing",
  "things",
  "tmp",
  "val",
  "vals",
  "value",
  "values",
  "x",
  "y",
  "z",
]);

// Words that add nothing to a placeholder: `myData`, `newValue` and `doStuff` are as empty as `data`.
const FILLER_WORDS = new Set([
  "the",
  "an",
  "my",
  "new",
  "old",
  "some",
  "other",
  "do",
  "get",
  "set",
]);

const QUANTITY_WORDS = new Set([
  "age",
  "backoff",
  "budget",
  "cap",
  "capacity",
  "delay",
  "duration",
  "expiry",
  "gap",
  "interval",
  "length",
  "lifetime",
  "limit",
  "margin",
  "max",
  "min",
  "period",
  "quota",
  "rate",
  "size",
  "timeout",
  "ttl",
  "wait",
  "window",
]);

const UNIT_WORDS = new Set([
  "attempts",
  "bits",
  "byte",
  "bytes",
  "characters",
  "chars",
  "count",
  "day",
  "days",
  "depth",
  "factor",
  "fps",
  "gb",
  "gib",
  "hour",
  "hours",
  "hz",
  "kb",
  "kib",
  "level",
  "levels",
  "lines",
  "mb",
  "mib",
  "micros",
  "millis",
  "milliseconds",
  "mins",
  "minute",
  "minutes",
  "ms",
  "nanos",
  "ns",
  "pct",
  "per",
  "percent",
  "px",
  "qps",
  "ratio",
  "retries",
  "rps",
  "s",
  "sec",
  "second",
  "seconds",
  "secs",
  "times",
  "us",
  "week",
  "weeks",
]);

const PREDICATE_PREFIXES = new Set([
  "allows",
  "can",
  "contains",
  "could",
  "did",
  "does",
  "exists",
  "had",
  "has",
  "have",
  "includes",
  "is",
  "matches",
  "must",
  "need",
  "needs",
  "requires",
  "should",
  "supports",
  "uses",
  "was",
  "were",
  "will",
  "would",
]);

const ADJECTIVES = new Set([
  "absent",
  "active",
  "alive",
  "async",
  "available",
  "busy",
  "clean",
  "complete",
  "dead",
  "dirty",
  "done",
  "empty",
  "equal",
  "exact",
  "fresh",
  "full",
  "idle",
  "known",
  "live",
  "local",
  "ok",
  "open",
  "optional",
  "partial",
  "pending",
  "present",
  "private",
  "public",
  "quiet",
  "readonly",
  "ready",
  "remote",
  "safe",
  "silent",
  "stale",
  "strict",
  "sync",
  "unique",
  "unknown",
  "unsafe",
  "valid",
  "verbose",
]);

const ADJECTIVE_SUFFIX = /(?:ed|able|ible|ive|ing|ful|less|ous)$/;
const PLURAL = /[^su]s$/;

// Shorter words that end like plurals or adjectives, such as "bus" or "feed", rarely are.
const MIN_PLURAL_CHARS = 4;
const MIN_SUFFIXED_ADJECTIVE_CHARS = 5;

// Names this short belong to short-name.
export const SHORT_NAME_MAX_CHARS = 2;

// `fetchUserById` -> fetch, user, by, id; `MAX_RETRY_MS` -> max, retry, ms; trailing digits are dropped.
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_$]+/)
    .map((word) => word.toLowerCase().replace(/\d+$/, ""))
    .filter(Boolean);
}

export function isPlaceholderName(name: string): boolean {
  const words = nameWords(name);
  const core = words.filter((word) => !FILLER_WORDS.has(word));

  return core.length > 0 && core.every((word) => PLACEHOLDER_WORDS.has(word));
}

function hasUnit(words: string[]): boolean {
  return words.some(
    (word) =>
      UNIT_WORDS.has(word) ||
      (word.length >= MIN_PLURAL_CHARS && PLURAL.test(word)),
  );
}

function readsAsPredicate(words: string[]): boolean {
  const first = words[0] ?? "";
  const last = words.at(-1) ?? "";

  return (
    PREDICATE_PREFIXES.has(first) ||
    [first, last].some(
      (word) =>
        ADJECTIVES.has(word) ||
        (word.length >= MIN_SUFFIXED_ADJECTIVE_CHARS &&
          ADJECTIVE_SUFFIX.test(word)),
    )
  );
}

// Why the name says nothing about what it holds, or undefined when it says enough.
export function genericNameProblem(identifier: Identifier): string | undefined {
  const { name } = identifier;
  const words = nameWords(name);

  if (isPlaceholderName(name) && !identifier.holdsAnyValue) {
    return `\`${name}\` is a placeholder that says nothing about what it holds or does.`;
  }

  const quantity = words.some((word) => QUANTITY_WORDS.has(word));
  const constant =
    identifier.constant ||
    identifier.kind === "const" ||
    /^[A-Z][A-Z0-9_]+$/.test(name);

  if (
    constant &&
    identifier.valueType === "number" &&
    quantity &&
    !hasUnit(words)
  ) {
    return `\`${name}\` holds a time, size or count but its name has no unit.`;
  }

  if (identifier.valueType === "boolean" && !readsAsPredicate(words)) {
    return `\`${name}\` holds a boolean but does not read as a yes-or-no question.`;
  }

  return undefined;
}

// A name the initializer suggests, unless it is itself a placeholder or the current name.
export function usefulSuggestion(identifier: Identifier): string | undefined {
  const { suggestion } = identifier;

  if (
    !suggestion ||
    suggestion === identifier.name ||
    isPlaceholderName(suggestion)
  ) {
    return undefined;
  }

  return suggestion;
}
