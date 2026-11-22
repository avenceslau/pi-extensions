import type { Trait } from "../../traits.ts";

export default {
  name: "code-restraint/swallowed-error",
  version: 1,
  subject: "Error handling.",
  requirement:
    "Do not swallow errors silently: no empty catch blocks, no `.catch(() => {})`, no `let _ =` or `.ok();` on a Rust Result without a comment saying why the error does not matter.",
  purpose: "A swallowed error turns a crash into silent wrong behavior.",
  candidate: "catch",
  check: "local",
  category: "error handling",
  severity: "warning",
  fix: "Handle, log or rethrow the error, or add a comment explaining why it is safe to ignore.",
} satisfies Trait;
