import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/comment",
  version: 1,
  subject: "A comment this change added, or one it left as it was directly above or inside code it edited, shown inside the function or statement around it.",
  requirement: "Assume the comment should not exist. Keep it only when it carries something the code cannot express: an external constraint, a linked bug or ticket, a specification or protocol detail, or the reason for a counterintuitive choice. A comment the change left next to code it edited must also still describe that code exactly.",
  purpose: "The code should say what it does; a comment that repeats or explains it goes stale and buries the comments that matter.",
  candidate: "comment",
  check: "agent",
  category: "comments",
  severity: "warning",
  fix: "Delete the comment, or make the code say it: rename what the comment explains, extract the step into a function named after what the comment says, or turn the claim into an assertion or a test.",
  body: [
    "No kind of comment is exempt: doc comments, `SAFETY:` notes, TODOs and section labels are judged like any other.",
    'Keep: "// Workers caps subrequests at 50 per invocation", "// See JIRA-123: the API returns 200 on partial failure", "// RFC 7231 allows a missing Content-Type here", "// Sorted descending so the newest lease wins the tie".',
    `Delete or replace: "// increment the counter", "// loop over the items", "// call the API", "// new helper for X", "// the user's id" over \`const id\`, "/** Returns the user's name. */" over \`getUserName()\`, "// returns true when ready" over \`function check()\` (rename it \`isReady\`), a section label that repeats the function name, a comment that explains what a badly named variable holds (rename the variable).`,
    'Stale: "// retry three times" over a loop that now retries five times, a comment naming a parameter that was renamed or removed, "// returns null when missing" over code that now throws.',
  ].join("\n"),
} satisfies Trait;
