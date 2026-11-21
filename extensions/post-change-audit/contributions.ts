import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RepoChange } from "./tracking.ts";

// Other packages add to the audit by listening on this channel. pi's event bus calls listeners synchronously, so
// every contribution is in by the time `emit` returns.
export const CONTRIBUTIONS_CHANNEL = "post-change-audit:contributions";

export interface Auditor {
  // The agent type to spawn; its definition must allow the ext:post-change-audit/report_findings tool.
  type: string;
  title: string;
  // Prepended to each finding's id, such as CR in CR1.
  idPrefix: string;
  focus: string;
}

export interface CorrectnessContext {
  // Appended to this repository's section of the prompt.
  lines: string[];
  // Added once to the prompt, after the repository sections.
  instructions?: string;
  // Runs once the review ends, whatever its outcome.
  release?(): Promise<void>;
}

// Asked for each repository by /correctness and /review-mr; the automatic correctness review reads and reasons only.
export type CorrectnessContextProvider = (
  change: RepoChange,
  options: {
    signal: AbortSignal;
    notify(message: string): void;
  },
) => Promise<CorrectnessContext | undefined>;

export interface AuditContributionRequest {
  // Runs beside the built-in auditors on every audit of the session's changes.
  addAuditor(auditor: Auditor): void;
  addCorrectnessContext(provider: CorrectnessContextProvider): void;
}

export interface AuditContributions {
  auditors: Auditor[];
  correctnessContexts: CorrectnessContextProvider[];
}

export function collectContributions(pi: ExtensionAPI): AuditContributions {
  const contributions: AuditContributions = {
    auditors: [],
    correctnessContexts: [],
  };
  const request: AuditContributionRequest = {
    addAuditor: (auditor) => contributions.auditors.push(auditor),
    addCorrectnessContext: (provider) => contributions.correctnessContexts.push(provider),
  };
  pi.events.emit(CONTRIBUTIONS_CHANNEL, request);
  return contributions;
}
