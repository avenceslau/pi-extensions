import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FORGE_READ_COMMANDS,
  GIT_READ_COMMANDS,
  GIT_WRITE_COMMANDS,
  READ_ONLY_COMMANDS,
} from "../guard/commands.ts";
import type {
  LocalAgentDefinition,
  Playbook,
  Repository,
} from "../definition.ts";
import { ciFailuresCheck, ciSpeedCheck } from "./ci.ts";
import {
  commentsCheck,
  conflictsCheck,
  hygieneCheck,
} from "./pull-requests.ts";

const PLAYBOOKS_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  "playbooks",
);

const READ_TOOLS = ["read", "grep", "find", "ls", "bash"];
const WRITE_TOOLS = [...READ_TOOLS, "edit", "write"];

const readOnlyCommands = () => [
  ...READ_ONLY_COMMANDS,
  ...GIT_READ_COMMANDS,
  ...FORGE_READ_COMMANDS,
];

const codeChangeCommands = (repository: Repository) => [
  ...readOnlyCommands(),
  ...GIT_WRITE_COMMANDS,
  ...repository.commands,
];

function playbook(
  name: string,
  fields: Omit<Playbook, "instructions">,
): Playbook {
  return {
    ...fields,
    instructions: join(PLAYBOOKS_DIRECTORY, `${name}.md`),
  };
}

const definition: LocalAgentDefinition = {
  name: "todai",
  checks: [
    conflictsCheck,
    commentsCheck,
    hygieneCheck,
    ciFailuresCheck,
    ciSpeedCheck,
  ],
  playbooks: {
    rebase: playbook("rebase", {
      tools: WRITE_TOOLS,
      commands: codeChangeCommands,
    }),
    comments: playbook("comments", {
      tools: WRITE_TOOLS,
      commands: codeChangeCommands,
      comment: true,
    }),
    review: playbook("review", {
      tools: READ_TOOLS,
      commands: readOnlyCommands,
      comment: true,
    }),
    "ci-failure": playbook("ci-failure", {
      tools: WRITE_TOOLS,
      commands: codeChangeCommands,
      mergeRequest: true,
    }),
    "ci-speed": playbook("ci-speed", {
      tools: WRITE_TOOLS,
      commands: codeChangeCommands,
      mergeRequest: true,
    }),
  },
};

export default definition;
