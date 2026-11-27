import { runProgram } from "../shared/exec.ts";
import { expandHome } from "./paths.ts";

export async function runReviewOpenedCommand(
  command: string[],
  agent: string,
  review: { title: string; url: string },
): Promise<void> {
  const [program, ...args] = command.map(expandHome);

  if (!program) {
    return;
  }

  await runProgram(program, args, {
    env: {
      LOCAL_AGENT: agent,
      REVIEW_TITLE: review.title,
      REVIEW_URL: review.url,
    },
  });
}
