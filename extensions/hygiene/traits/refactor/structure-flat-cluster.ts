import type { Trait } from "../../traits.ts";

export default {
  name: "refactor/structure-flat-cluster",
  version: 1,
  subject: "Files added or changed by the diff and their sibling files.",
  requirement:
    "Group files by primitive, not by layer. Flag an added file that joins a flat cluster of files sharing a primitive-name prefix (semaphore-*.ts, stepConcurrency*.ts), or a layer folder (handlers/, services/, managers/) where the same primitive repeats.",
  purpose: "A directory listing should show the package's primitives.",
  candidate: "path",
  check: "local",
  category: "layout",
  sizeThreshold: 3,
  severity: "warning",
  fix: "Move `{prefix}*` into a `{prefix}/` folder and drop the prefix from the file names.",
} satisfies Trait;
