import { resolve } from "node:path";
import { expandHome, isInside } from "../paths.ts";

// Decides whether a local agent may run a bash command. Every command in a list or pipeline must match one of the
// allowed patterns, where `*` matches one word and a trailing `**` matches the rest of the command. Shell features
// that could run or write something the patterns do not show are refused outright: substitutions, variables,
// subshells, background jobs, heredocs, and redirections other than discarding output.

export type CommandVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason: string;
    };

interface Word {
  text: string;
  isRedirection: boolean;
}

type Token = Word | { operator: string };

export const READ_ONLY_COMMANDS = [
  "ls **",
  "cat **",
  "head **",
  "tail **",
  "wc **",
  "grep **",
  "rg **",
  "find **",
  "pwd",
  "echo **",
  "sort **",
  "uniq **",
  "cut **",
  "tr **",
  "diff **",
  "jq **",
  "file **",
  "stat **",
  "tree **",
  "basename **",
  "dirname **",
  "realpath **",
  "which **",
  "date **",
  "true",
];

export const GIT_READ_COMMANDS = [
  "git status **",
  "git log **",
  "git show **",
  "git diff **",
  "git blame **",
  "git branch --show-current",
  "git branch --list **",
  "git branch -a **",
  "git branch -r **",
  "git rev-parse **",
  "git merge-base **",
  "git ls-files **",
  "git ls-tree **",
  "git cat-file **",
  "git grep **",
  "git describe **",
  "git shortlog **",
  "git range-diff **",
  "git fetch **",
];

export const GIT_WRITE_COMMANDS = [
  "git add **",
  "git commit **",
  "git rebase **",
  "git restore **",
  "git checkout **",
  "git switch **",
  "git stash **",
  "git cherry-pick **",
  "git reset **",
  "git rm **",
  "git mv **",
  "git apply **",
  "git revert **",
];

export const FORGE_READ_COMMANDS = [
  "glab mr view **",
  "glab mr diff **",
  "glab api **",
  "gh pr view **",
  "gh pr diff **",
  "gh pr checks **",
  "gh run view **",
  "gh run list **",
  "gh api **",
];

// `gh api` and `glab api` send a GET unless one of these is given.
const API_WRITE_OPTIONS = [
  "-X",
  "--method",
  "-f",
  "-F",
  "--field",
  "--raw-field",
  "--input",
];

// Options that make an otherwise read-only or local command run another program, write a file, or call a write API.
const FORBIDDEN_OPTIONS: Record<string, string[]> = {
  find: [
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-delete",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
  ],
  rg: ["--pre"],
  sort: ["-o", "--output"],
  tree: ["-o"],
  "git diff": ["--output"],
  "git log": ["--output"],
  "git show": ["--output"],
  "git grep": ["-O", "--open-files-in-pager"],
  "git fetch": ["--upload-pack"],
  "git rebase": ["-x", "--exec"],
  "gh api": API_WRITE_OPTIONS,
  "glab api": API_WRITE_OPTIONS,
};

const ALLOWED_VARIABLES = new Set([
  "CI",
  "DEBUG",
  "FORCE_COLOR",
  "NO_COLOR",
  "NODE_ENV",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "TZ",
]);

const DISCARDED_OUTPUT = new Set([
  "2>&1",
  ">/dev/null",
  "2>/dev/null",
  "&>/dev/null",
]);

const REDIRECT_TO_FILE = new Set([">", "2>", "&>"]);

function refuse(reason: string): CommandVerdict {
  return {
    allowed: false,
    reason,
  };
}

function tokenize(command: string): Token[] | string {
  const tokens: Token[] = [];
  let word: Word | undefined;
  let quote: "'" | '"' | undefined;

  const extend = (text: string, isRedirection = false) => {
    word ??= {
      text: "",
      isRedirection: false,
    };
    word.text += text;
    word.isRedirection ||= isRedirection;
  };

  const finishWord = () => {
    if (word) {
      tokens.push(word);
      word = undefined;
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];

    if (quote === "'") {
      if (character === "'") {
        quote = undefined;
      } else {
        extend(character);
      }

      continue;
    }

    if (character === "`" || character === "$") {
      return "command substitution and variables are not allowed";
    }

    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\" && next !== undefined) {
        extend(next);
        index += 1;
      } else {
        extend(character);
      }

      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      extend("");
      continue;
    }

    if (character === "\\") {
      if (next === "\n") {
        index += 1;
      } else if (next !== undefined) {
        extend(next);
        index += 1;
      }

      continue;
    }

    if (character === " " || character === "\t") {
      finishWord();
      continue;
    }

    if (character === "\n" || character === ";") {
      finishWord();
      tokens.push({ operator: ";" });
      continue;
    }

    if (character === "&" && next === "&") {
      finishWord();
      tokens.push({ operator: "&&" });
      index += 1;
      continue;
    }

    if (character === "|") {
      if (next === "&") {
        return "`|&` is not allowed";
      }

      finishWord();
      tokens.push({ operator: next === "|" ? "||" : "|" });
      index += next === "|" ? 1 : 0;
      continue;
    }

    if (character === ">" || character === "<" || character === "&") {
      if (character === "<") {
        return "input redirection and heredocs are not allowed";
      }

      extend(character, true);
      continue;
    }

    if (character === "(" || character === ")") {
      return "subshells are not allowed";
    }

    if (character === "#" && word === undefined) {
      return "shell comments are not allowed";
    }

    extend(character);
  }

  if (quote) {
    return "the command has an unterminated quote";
  }

  finishWord();

  return tokens;
}

function splitCommands(tokens: Token[]): Word[][] {
  const commands: Word[][] = [[]];

  for (const token of tokens) {
    if ("operator" in token) {
      commands.push([]);
    } else {
      commands[commands.length - 1].push(token);
    }
  }

  return commands.filter((words) => words.length > 0);
}

function looksLikePath(text: string): boolean {
  return (
    text.startsWith("/") ||
    text.startsWith("~") ||
    text.split("/").includes("..")
  );
}

function pathOutside(
  root: string,
  cwd: string,
  words: string[],
): string | undefined {
  for (const word of words) {
    const candidates = word.includes("=")
      ? [word, word.slice(word.indexOf("=") + 1)]
      : [word];

    for (const value of candidates) {
      if (!looksLikePath(value) || value === "/dev/null") {
        continue;
      }

      if (!isInside(root, resolve(cwd, expandHome(value)))) {
        return value;
      }
    }
  }

  return undefined;
}

function matchesPattern(pattern: string, words: string[]): boolean {
  const parts = pattern.split(/\s+/);

  for (const [index, part] of parts.entries()) {
    if (part === "**" && index === parts.length - 1) {
      return true;
    }

    if (index >= words.length) {
      return false;
    }

    if (part !== "*" && part !== words[index]) {
      return false;
    }
  }

  return parts.length === words.length;
}

// A single-letter option such as `-O`, which can take its value without a space: `-Ovim`.
function isShortOption(option: string): boolean {
  return /^-[A-Za-z]$/.test(option);
}

function forbiddenOption(words: string[]): string | undefined {
  const keys = [words[0], `${words[0]} ${words[1] ?? ""}`];
  const options = keys.flatMap((key) => FORBIDDEN_OPTIONS[key] ?? []);

  return words.find((word) =>
    options.some(
      (option) =>
        word === option ||
        word.startsWith(`${option}=`) ||
        (isShortOption(option) && word.startsWith(option)),
    ),
  );
}

type ParsedCommand = { words: string[] } | { reason: string };

// Drops the leading variable assignments and the redirections that only discard output.
function parseCommand(words: Word[]): ParsedCommand {
  const remaining = [...words];

  while (remaining[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(remaining[0].text)) {
    const name = remaining[0].text.slice(0, remaining[0].text.indexOf("="));

    if (!ALLOWED_VARIABLES.has(name)) {
      return { reason: `setting ${name} is not allowed` };
    }

    remaining.shift();
  }

  const kept: string[] = [];

  for (let index = 0; index < remaining.length; index += 1) {
    const word = remaining[index];

    if (!word.isRedirection) {
      kept.push(word.text);
      continue;
    }

    if (DISCARDED_OUTPUT.has(word.text)) {
      continue;
    }

    if (
      REDIRECT_TO_FILE.has(word.text) &&
      remaining[index + 1]?.text === "/dev/null"
    ) {
      index += 1;
      continue;
    }

    return {
      reason:
        "redirections other than discarding output to /dev/null are not allowed",
    };
  }

  return { words: kept };
}

export function checkCommand(
  command: string,
  allow: string[],
  root: string,
  cwd = root,
): CommandVerdict {
  const tokens = tokenize(command);

  if (typeof tokens === "string") {
    return refuse(tokens);
  }

  let directory = cwd;

  for (const segment of splitCommands(tokens)) {
    const parsed = parseCommand(segment);

    if ("reason" in parsed) {
      return refuse(parsed.reason);
    }

    const { words } = parsed;
    const [program, cdTarget, ...cdExtra] = words;

    const outside = pathOutside(root, directory, words);

    if (outside) {
      return refuse(`${outside} is outside the worktree ${root}`);
    }

    if (program === "cd" && cdTarget !== undefined && cdExtra.length === 0) {
      directory = resolve(directory, expandHome(cdTarget));
      continue;
    }

    const option = forbiddenOption(words);

    if (option) {
      return refuse(`\`${program}\` with ${option} is not allowed`);
    }

    if (!allow.some((pattern) => matchesPattern(pattern, words))) {
      return refuse(
        `\`${words.join(" ")}\` is not an allowed command. Allowed patterns: ${allow.join(", ")}`,
      );
    }
  }

  return { allowed: true };
}
