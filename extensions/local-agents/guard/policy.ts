import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// What one agent session may do. The launcher writes it to a file and passes the path in LOCAL_AGENT_POLICY;
// the guard reads it and enforces it on every tool call.
const RunPolicySchema = Type.Object({
  agent: Type.String(),
  runId: Type.String(),
  worktree: Type.String(),
  gitDirectory: Type.String(),
  statusFile: Type.String(),
  tools: Type.Array(Type.String()),
  bashCommandPatterns: Type.Array(Type.String()),
  repository: Type.Object({
    forge: Type.Union([Type.Literal("github"), Type.Literal("gitlab")]),
    host: Type.String(),
    project: Type.String(),
    url: Type.String(),
  }),
  review: Type.Optional(
    Type.Object({
      number: Type.Number(),
      url: Type.String(),
    }),
  ),
  // Lets push_branch force-push HEAD to this branch, but only over the commit the trigger saw.
  push: Type.Optional(
    Type.Object({
      branch: Type.String(),
      expectedSha: Type.String(),
      askFirst: Type.Boolean(),
    }),
  ),
  // Lets open_merge_request push HEAD to a new `<agent>/...` branch and open a review into this branch, after the
  // user confirms.
  mergeRequest: Type.Optional(
    Type.Object({
      targetBranch: Type.String(),
    }),
  ),
  // Lets post_comment comment on the review, after the user confirms.
  comment: Type.Optional(Type.Boolean()),
});

const RunStatusFileSchema = Type.Object({
  pid: Type.Number(),
  status: Type.Union([
    Type.Literal("working"),
    Type.Literal("waiting"),
    Type.Literal("idle"),
  ]),
  updatedAt: Type.String(),
});

export type RunPolicy = Static<typeof RunPolicySchema>;

export type RunStatusFile = Static<typeof RunStatusFileSchema>;

export type RunStatus = RunStatusFile["status"];

export const POLICY_VARIABLE = "LOCAL_AGENT_POLICY";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseRunPolicy(text: string): RunPolicy | undefined {
  const value = parseJson(text);

  return Value.Check(RunPolicySchema, value) ? value : undefined;
}

export function parseRunStatus(text: string): RunStatusFile | undefined {
  const value = parseJson(text);

  return Value.Check(RunStatusFileSchema, value) ? value : undefined;
}
