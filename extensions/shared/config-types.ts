// Plain types with no imports, so a TypeScript config file can import them without this package's dependencies.
// config.ts validates against a schema that the compiler checks is equal to PiExtensionsConfig.

export interface ClefConfig {
  url: string;
  // "clef" (the default) or "clef-flash", the smaller and faster model.
  model?: string;
  auth?: {
    header: string;
    // Run to print a token; a JWT is reused until shortly before its `exp`, any other token is fetched every call.
    command?: string[];
    token?: string;
  };
}

export interface ModelsConfig {
  primary?: string[];
  subagent?: string[];
  // Regular expressions for models no subagent may run on.
  subagentForbidden?: string[];
  // Regular expression for an error that means only the current model is down.
  unavailable?: string;
  // Model for each agent type, used when an Agent call or audit spawn names none.
  agents?: Record<string, string>;
  // Model for each extension that makes its own model calls, by extension name: btw, bug-fix, session-focus.
  extensions?: Record<string, string>;
}

export type Forge = "github" | "gitlab";

// Agent types added to the built-in lists; each source adds to the ones before it.
export interface AgentRolesConfig {
  // Cannot write files or change git state.
  readOnly?: string[];
  // Launched only by the post-change audit and the user's review commands, and off while /review is off.
  review?: string[];
}

export interface LocalAgentRepositoryConfig {
  // Host and project path, such as github.com/owner/repo.
  url: string;
  // Local clone that the agent's worktrees are created from; `~` is expanded.
  path: string;
  // Commands agents that change code may run in this repository's worktrees, such as "pnpm test **". In a
  // pattern `*` matches one word and a trailing `**` matches the rest of the command.
  commands?: string[];
  // Run in the worktree, in the agents' sandbox, before each run of a playbook that runs the repository's code, such as
  // ["pnpm", "install", "--frozen-lockfile"].
  setup?: string[];
}

export interface LocalAgentConfig {
  repositories?: LocalAgentRepositoryConfig[];
  model?: string;
  thinking?: string;
  // Extension files every agent session loads besides the guard, such as the one that provides the model.
  extensions?: string[];
  maxRunningAgents?: number;
  // Regular expressions for usernames treated as bots, whose reviews and comments are ignored.
  ignoredAuthors?: string[];
  // Run once for each merge request the agent opens, with LOCAL_AGENT, REVIEW_TITLE, and REVIEW_URL set, for example
  // to post it to a chat. `~` is expanded in each word.
  reviewOpenedCommand?: string[];
}

export interface PiExtensionsConfig {
  btw?: {
    backend?: "herdr" | "rex";
  };
  clef?: ClefConfig;
  // Local agents by name, run by extensions/local-agents/cli.ts.
  localAgents?: Record<string, LocalAgentConfig>;
  models?: ModelsConfig;
  forges?: Record<string, Forge>;
  agentRoles?: AgentRolesConfig;
  sessionFocus?: {
    backend?: "pi" | "rex";
  };
}

export interface ConfigRequest {
  contribute(config: PiExtensionsConfig): void;
}
