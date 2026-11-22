import { setTimeout } from "node:timers/promises";
import { askClef, type ClefQuestion } from "../shared/clef.ts";
import type { ClefConfig } from "../shared/config.ts";

const AUDIT_OPT_OUT =
  /\b(?:no|skip|without|don['’]?t|do\s+not)\s+(?:run\s+)?(?:an?\s+|the\s+|any\s+)?(?:code[\s-]?)?(?:review|audit)(?:s|ing)?\b/i;

// Replies such as "ok" or "go ahead" carry no opt-out that the keyword rule misses.
const CLEF_OPT_OUT_MIN_CHARS = 12;
const CLEF_OPT_OUT_THRESHOLD = 0.6;
const CLEF_OPT_OUT_WAIT_MS = 3_000;

const CLEF_OPT_OUT_QUESTION: ClefQuestion = {
  type: "noul",
  instructions:
    "Does this message ask the agent to skip, not run, or not bother with the automatic code review or post-change audit of its work?",
  criteria: {
    true: "Asks to skip the review or audit",
    false: "Does not ask to skip it; asking for a review, or mentioning reviews in another sense, is not skipping",
  },
};

export interface OptOutCheck {
  keyword: boolean;
  // Asked only when the keyword rule does not match.
  clefScore?: Promise<number>;
}

export interface OptOutDecision {
  optedOut: boolean;
  // Clef answered in time.
  clefScore?: number;
  // Clef failed or did not answer in time.
  clefError?: string;
}

export function startOptOutCheck(message: string, clef: ClefConfig | undefined, signal: AbortSignal): OptOutCheck {
  const keyword = AUDIT_OPT_OUT.test(message);

  if (
    keyword ||
    !clef ||
    message.trim().length < CLEF_OPT_OUT_MIN_CHARS
  ) {
    return { keyword };
  }

  const clefScore = askClef(clef, message, { optOut: CLEF_OPT_OUT_QUESTION }, signal).then(({ scores }) => scores.optOut);
  // The score is read only when the turn settles, which may never happen.
  clefScore.catch(() => undefined);

  return { keyword, clefScore };
}

// Clef can only add an opt-out to the keyword rule; an answer still pending after the wait counts as none.
export async function decideOptOut(check: OptOutCheck): Promise<OptOutDecision> {
  if (!check.clefScore) {
    return { optedOut: check.keyword };
  }

  try {
    const clefScore = await Promise.race([
      check.clefScore,
      setTimeout(CLEF_OPT_OUT_WAIT_MS, undefined, { ref: false }),
    ]);

    if (clefScore === undefined) {
      return {
        optedOut: false,
        clefError: `no answer within ${CLEF_OPT_OUT_WAIT_MS / 1000} s`,
      };
    }

    return {
      optedOut: clefScore >= CLEF_OPT_OUT_THRESHOLD,
      clefScore,
    };
  } catch (error) {
    return {
      optedOut: false,
      clefError: String(error),
    };
  }
}
