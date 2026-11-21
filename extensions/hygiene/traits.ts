import codeRestraintCeremonyName from "./traits/code-restraint/ceremony-name.ts";
import codeRestraintCoinedName from "./traits/code-restraint/coined-name.ts";
import codeRestraintComment from "./traits/code-restraint/comment.ts";
import codeRestraintDeepNesting from "./traits/code-restraint/deep-nesting.ts";
import codeRestraintDenseLine from "./traits/code-restraint/dense-line.ts";
import codeRestraintGenericName from "./traits/code-restraint/generic-name.ts";
import codeRestraintMagicNumber from "./traits/code-restraint/magic-number.ts";
import codeRestraintMagicOffset from "./traits/code-restraint/magic-offset.ts";
import codeRestraintOneUseHelper from "./traits/code-restraint/one-use-helper.ts";
import codeRestraintSameLineBody from "./traits/code-restraint/same-line-body.ts";
import codeRestraintShortName from "./traits/code-restraint/short-name.ts";
import codeRestraintSpeculativeKnob from "./traits/code-restraint/speculative-knob.ts";
import codeRestraintSwallowedError from "./traits/code-restraint/swallowed-error.ts";
import codeRestraintTestEitherOutcome from "./traits/code-restraint/test-either-outcome.ts";
import codeRestraintTrivialWrapper from "./traits/code-restraint/trivial-wrapper.ts";
import codeRestraintUndescriptiveName from "./traits/code-restraint/undescriptive-name.ts";
import refactorDuplication from "./traits/refactor/duplication.ts";
import refactorForwardingChain from "./traits/refactor/forwarding-chain.ts";
import refactorMixedResponsibilities from "./traits/refactor/mixed-responsibilities.ts";
import refactorScopeCreep from "./traits/refactor/scope-creep.ts";
import refactorStructureFlatCluster from "./traits/refactor/structure-flat-cluster.ts";
import refactorTangledBranching from "./traits/refactor/tangled-branching.ts";

export const CATEGORY_NAMES = [
  "nesting",
  "naming",
  "comments",
  "error handling",
  "simplicity",
  "layout",
] as const;

interface SharedTraitFields {
  name: `${string}/${string}`;
  // Bumping it drops this rule's cached Clef answers.
  version: number;
  subject: string;
  requirement: string;
  purpose: string;
  candidate: string;
  category: (typeof CATEGORY_NAMES)[number];
  severity: "error" | "warning" | "info";
  fix: string;
  // May use {name} and {candidate} placeholders.
  alternate?: string;
  skipWhenFormatted?: boolean;
  body?: string;
}

export type Trait = SharedTraitFields &
  (
    | { check: "clef"; probabilityThreshold: number }
    | { check: "local"; sizeThreshold?: number }
    // agent: judged by the post-change audit's comment-review agent; the linter only builds its candidates.
    | { check: "agent" | "llm" }
  );

export const TRAITS: ReadonlyMap<string, Trait> = new Map(
  [
    codeRestraintCeremonyName,
    codeRestraintCoinedName,
    codeRestraintComment,
    codeRestraintDeepNesting,
    codeRestraintDenseLine,
    codeRestraintGenericName,
    codeRestraintMagicNumber,
    codeRestraintMagicOffset,
    codeRestraintOneUseHelper,
    codeRestraintSameLineBody,
    codeRestraintShortName,
    codeRestraintSpeculativeKnob,
    codeRestraintSwallowedError,
    codeRestraintTestEitherOutcome,
    codeRestraintTrivialWrapper,
    codeRestraintUndescriptiveName,
    refactorDuplication,
    refactorForwardingChain,
    refactorMixedResponsibilities,
    refactorScopeCreep,
    refactorStructureFlatCluster,
    refactorTangledBranching,
  ].map((trait) => [trait.name, trait]),
);
