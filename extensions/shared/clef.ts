import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { ClefConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

const CLEF_TIMEOUT_MS = 30_000;

// Both the audit and the hygiene linter send these requests.
const USER_AGENT = "pi-extensions";
const NOT_CONFIGURED =
  "Clef is not configured: add clef to the default export of ~/.pi/agent/pi-extensions.ts";

// A token command can take about a second, so a JWT is reused until shortly before it expires.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

// Clef rejects a call with more questions with a 422.
export const CLEF_MAX_QUESTIONS = 64;

// Clef rejects a state over 65,529 tokens with a 422 instead of truncating it. Code averages about
// 3.35 characters per token, so this keeps typical diffs about 10% under the limit.
export const CLEF_MAX_STATE_CHARS = 200_000;
const BATCH_CONCURRENCY = 8;

const SECRETS: [RegExp, string][] = [
  [
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    "[REDACTED]",
  ],
  [
    /\b(?:gh[pousr]_|glpat-)[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b/g,
    "[REDACTED]",
  ],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED]",
  ],
  [
    /((?:secret|token|password|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^"'\s]{12,}/gi,
    "$1[REDACTED]",
  ],
];

const ClefAnswersSchema = Type.Object({
  answers: Type.Record(Type.String(), Type.Object({ noul: Type.Number() })),
});

// The Workers AI REST API wraps the model's output in `{ result, success, errors }`; other routes return it bare.
const ClefResponseSchema = Type.Union([
  ClefAnswersSchema,
  Type.Object({ result: ClefAnswersSchema }),
]);

export interface ClefQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export interface ClefAnswers<Key extends string> {
  scores: Record<Key, number>;
  // Clef saw only the start of the state.
  truncated: boolean;
}

export interface ClefBatch {
  state: string;
  questions: ClefQuestion[];
}

export interface ClefBatchAnswers {
  // One probability per question of each batch, undefined where its call failed.
  answers: (number | undefined)[][];
  calls: number;
  failures: number;
  lastError?: string;
}

let cachedToken:
  | { command: string; value: string; refreshAt: number }
  | undefined;

function redactSecrets(text: string): string {
  return SECRETS.reduce(
    (redacted, [pattern, replacement]) =>
      redacted.replace(pattern, replacement),
    text,
  );
}

function tokenExpiry(token: string): number | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );

    return typeof claims?.exp === "number" ? claims.exp * 1_000 : undefined;
  } catch {
    return undefined;
  }
}

async function commandToken(
  commandLine: string[],
  signal?: AbortSignal,
): Promise<string> {
  const [program, ...args] = commandLine;
  const command = JSON.stringify(commandLine);

  if (cachedToken?.command === command && Date.now() < cachedToken.refreshAt) {
    return cachedToken.value;
  }

  const { stdout } = await execFileAsync(program, args, {
    timeout: CLEF_TIMEOUT_MS,
    signal,
  });

  const value = stdout.trim();

  if (value === "") {
    throw new Error(`${program} printed no Clef token`);
  }

  const expiry = tokenExpiry(value);
  cachedToken =
    expiry === undefined
      ? undefined
      : { command, value, refreshAt: expiry - TOKEN_REFRESH_MARGIN_MS };

  return value;
}

async function authHeaders(
  clef: ClefConfig,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const { auth } = clef;

  if (!auth) {
    return {};
  }

  const token = auth.command?.length
    ? await commandToken(auth.command, signal)
    : auth.token;

  return token === undefined ? {} : { [auth.header]: token };
}

class ClefStatusError extends Error {
  readonly _tag = "ClefStatusError";
  status: number;

  constructor(status: number) {
    super(`Clef returned ${status}`);
    this.status = status;
  }
}

function isClefStatusError(error: unknown): error is ClefStatusError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "ClefStatusError"
  );
}

// Clef answers on Workers AI's model-run routes; OpenAI-compatible routes drop the answers.
async function requestAnswers(
  endpoint: Pick<ClefConfig, "url" | "model">,
  auth: Record<string, string>,
  state: string,
  questions: Record<string, ClefQuestion>,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  const timeout = AbortSignal.timeout(CLEF_TIMEOUT_MS);

  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      // Makes an Access-protected gateway answer 401 instead of redirecting to its login page.
      "X-Requested-With": "xmlhttprequest",
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      ...auth,
    },
    body: JSON.stringify({
      model: endpoint.model ?? "clef",
      state,
      questions,
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  if (!response.ok) {
    throw new ClefStatusError(response.status);
  }

  const body = Value.Parse(ClefResponseSchema, await response.json());
  const { answers } = "result" in body ? body.result : body;
  const scores: Record<string, number> = {};

  for (const key of Object.keys(questions)) {
    const answer = answers[key];

    if (!answer) {
      throw new Error(`Clef returned no answer for ${key}`);
    }

    scores[key] = answer.noul;
  }

  return scores;
}

export async function askClef<Key extends string>(
  clef: ClefConfig | undefined,
  state: string,
  questions: Record<Key, ClefQuestion>,
  signal?: AbortSignal,
): Promise<ClefAnswers<Key>> {
  if (!clef) {
    throw new Error(NOT_CONFIGURED);
  }

  const auth = await authHeaders(clef, signal);
  const redacted = redactSecrets(state);
  let sent = redacted.slice(0, CLEF_MAX_STATE_CHARS);
  let scores: Record<string, number>;

  try {
    scores = await requestAnswers(clef, auth, sent, questions, signal);
  } catch (error) {
    // Text denser than code, such as lockfiles, can exceed the token limit within the character limit.
    const overTokenLimit = isClefStatusError(error) && error.status === 422;

    if (!overTokenLimit) {
      throw error;
    }

    sent = sent.slice(0, Math.floor(sent.length / 2));
    scores = await requestAnswers(clef, auth, sent, questions, signal);
  }

  return {
    scores: scores as Record<Key, number>,
    truncated: sent.length < redacted.length,
  };
}

// Batches over CLEF_MAX_QUESTIONS are split into calls that share the state, and each call fails on its own.
// A cut state would lose the questions' context, so states are sent whole; the caller leaves out states over
// CLEF_MAX_STATE_CHARS, and Clef rejects a call whose state is still over its token limit.
export async function askClefInBatches(
  clef: ClefConfig,
  batches: ClefBatch[],
  signal?: AbortSignal,
): Promise<ClefBatchAnswers> {
  const calls: { batch: number; offset: number; questions: ClefQuestion[] }[] =
    [];
  batches.forEach((batch, index) => {
    for (
      let offset = 0;
      offset < batch.questions.length;
      offset += CLEF_MAX_QUESTIONS
    ) {
      calls.push({
        batch: index,
        offset,
        questions: batch.questions.slice(offset, offset + CLEF_MAX_QUESTIONS),
      });
    }
  });

  const result: ClefBatchAnswers = {
    answers: batches.map((batch) => new Array(batch.questions.length)),
    calls: 0,
    failures: 0,
  };

  if (calls.length === 0) {
    return result;
  }

  let auth: Record<string, string>;

  try {
    auth = await authHeaders(clef, signal);
  } catch (error) {
    result.calls = calls.length;
    result.failures = calls.length;
    result.lastError = String(error);

    return result;
  }

  const states = batches.map((batch) => redactSecrets(batch.state));
  let next = 0;

  const worker = async () => {
    while (next < calls.length && !signal?.aborted) {
      const call = calls[next];
      next += 1;
      result.calls += 1;
      const questions = Object.fromEntries(
        call.questions.map((question, index) => [`q${index}`, question]),
      );

      try {
        const scores = await requestAnswers(
          clef,
          auth,
          states[call.batch],
          questions,
          signal,
        );

        call.questions.forEach((_, index) => {
          result.answers[call.batch][call.offset + index] = scores[`q${index}`];
        });
      } catch (error) {
        result.failures += 1;
        result.lastError = String(error);
      }
    }
  };

  await Promise.all(Array.from({ length: BATCH_CONCURRENCY }, worker));

  return result;
}
