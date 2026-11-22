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
  // Model for each extension that makes its own model calls, by extension name: btw, session-focus.
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

export interface PiExtensionsConfig {
  btw?: {
    backend?: "herdr" | "rex";
  };
  clef?: ClefConfig;
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
