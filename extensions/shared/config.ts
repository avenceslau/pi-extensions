import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ConfigRequest, ModelsConfig, PiExtensionsConfig } from "./config-types.ts";

export type {
  AgentRolesConfig,
  ClefConfig,
  ConfigRequest,
  Forge,
  ModelsConfig,
  PiExtensionsConfig,
} from "./config-types.ts";

const ClefConfigSchema = Type.Object({
  url: Type.String(),
  model: Type.Optional(Type.String()),
  auth: Type.Optional(
    Type.Object({
      header: Type.String(),
      command: Type.Optional(Type.Array(Type.String())),
      token: Type.Optional(Type.String()),
    }),
  ),
});

const ModelsConfigSchema = Type.Object({
  primary: Type.Optional(Type.Array(Type.String())),
  subagent: Type.Optional(Type.Array(Type.String())),
  subagentForbidden: Type.Optional(Type.Array(Type.String())),
  unavailable: Type.Optional(Type.String()),
  agents: Type.Optional(Type.Record(Type.String(), Type.String())),
  extensions: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const ForgeSchema = Type.Union([Type.Literal("github"), Type.Literal("gitlab")]);

const AgentRolesConfigSchema = Type.Object({
  readOnly: Type.Optional(Type.Array(Type.String())),
  review: Type.Optional(Type.Array(Type.String())),
});

const PiExtensionsConfigSchema = Type.Object({
  clef: Type.Optional(ClefConfigSchema),
  models: Type.Optional(ModelsConfigSchema),
  forges: Type.Optional(Type.Record(Type.String(), ForgeSchema)),
  agentRoles: Type.Optional(AgentRolesConfigSchema),
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// Fails to compile when the schema and the hand-written types drift apart.
const schemaMatchesTypes: Equal<Static<typeof PiExtensionsConfigSchema>, PiExtensionsConfig> = true;

void schemaMatchesTypes;

export function isForbiddenForSubagents(models: ModelsConfig | undefined, modelRef: string): boolean {
  return (models?.subagentForbidden ?? []).some((pattern) => new RegExp(pattern, "i").test(modelRef));
}

// The comma-separated `provider/modelId` list in an env var, which wins over the configured chain.
export function modelChainFromEnv(value: string | undefined): string[] | undefined {
  const chain = (value ?? "")
    .split(",")
    .map((modelRef) => modelRef.trim())
    .filter((modelRef) => modelRef.includes("/"));

  return chain.length > 0 ? chain : undefined;
}

// Other packages add their config by listening on this channel and calling `contribute`. pi's event bus calls
// listeners synchronously, so every contribution is in by the time `emit` returns.
export const CONFIG_CHANNEL = "pi-extensions:config";

// Subagent sessions run in the parent's process and may not load the user-config extension, so the user config read
// at session start is kept for every session in the process.
const USER_CONFIG_KEY = Symbol.for("pi-extensions/user-config");

export function userConfigPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "pi-extensions.ts");
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

export function parseConfig(value: unknown, source: string): PiExtensionsConfig {
  if (!Value.Check(PiExtensionsConfigSchema, value)) {
    const problem = [...Value.Errors(PiExtensionsConfigSchema, value)][0];
    throw new Error(`Invalid config from ${source}: ${problem?.instancePath || "/"} ${problem?.message ?? ""}`.trim());
  }

  return value;
}

// The file is a TypeScript module whose default export is the config. Node caches modules by URL, so the
// modification time in the URL makes an edited file load fresh.
export async function readUserConfig(path = userConfigPath()): Promise<PiExtensionsConfig> {
  let modifiedAt: number;

  try {
    modifiedAt = (await stat(path)).mtimeMs;
  } catch (error) {
    if (isMissingFile(error)) {
      return {};
    }

    throw error;
  }

  const module: { default?: unknown } = await import(`${pathToFileURL(path).href}?modified=${modifiedAt}`);

  return parseConfig(module.default, path);
}

// Another copy of this module, such as an older one in a session started before an update, may have stored it.
function cachedUserConfig(): PiExtensionsConfig {
  const cached: unknown = Reflect.get(globalThis, USER_CONFIG_KEY);

  return Value.Check(PiExtensionsConfigSchema, cached) ? cached : {};
}

// An invalid file leaves no user config in force, so a broken edit cannot keep half-applied settings.
export async function refreshUserConfig(path = userConfigPath()): Promise<void> {
  Reflect.set(globalThis, USER_CONFIG_KEY, undefined);
  Reflect.set(globalThis, USER_CONFIG_KEY, await readUserConfig(path));
}

export function mergeConfig(base: PiExtensionsConfig, override: PiExtensionsConfig): PiExtensionsConfig {
  return {
    clef: override.clef ?? base.clef,
    models: {
      ...base.models,
      ...override.models,
      agents: {
        ...base.models?.agents,
        ...override.models?.agents,
      },
      extensions: {
        ...base.models?.extensions,
        ...override.models?.extensions,
      },
    },
    forges: {
      ...base.forges,
      ...override.forges,
    },
    agentRoles: {
      readOnly: [...(base.agentRoles?.readOnly ?? []), ...(override.agentRoles?.readOnly ?? [])],
      review: [...(base.agentRoles?.review ?? []), ...(override.agentRoles?.review ?? [])],
    },
  };
}

// Call after every extension has loaded, such as in a session_start handler or later; a contribution registered by
// an extension that loads after the caller is missed when this runs in the caller's factory. The user config is the
// copy extensions/user-config/index.ts read at the last session start or /reload.
export function loadConfig(pi: Pick<ExtensionAPI, "events">): PiExtensionsConfig {
  const contributed: PiExtensionsConfig[] = [];

  const request: ConfigRequest = {
    contribute: (config) => contributed.push(parseConfig(config, "a package")),
  };

  pi.events.emit(CONFIG_CHANNEL, request);

  return [...contributed, cachedUserConfig()].reduce(mergeConfig, {});
}
