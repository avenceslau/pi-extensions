import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_CHANNEL,
  isForbiddenForSubagents,
  loadConfig,
  mergeConfig,
  modelChainFromEnv,
  readUserConfig,
  refreshUserConfig,
  type ConfigRequest,
} from "./config.ts";

type EventsOnly = Pick<ExtensionAPI, "events">;

function fakePi(): EventsOnly {
  const emitter = new EventEmitter();

  return {
    events: {
      emit: (channel, data) => {
        emitter.emit(channel, data);
      },
      on: (channel, handler) => {
        emitter.on(channel, handler);

        return () => emitter.off(channel, handler);
      },
    },
  };
}

function isConfigRequest(data: unknown): data is ConfigRequest {
  return (
    typeof data === "object" &&
    data !== null &&
    "contribute" in data &&
    typeof data.contribute === "function"
  );
}

function onConfigRequest(
  pi: EventsOnly,
  handler: (request: ConfigRequest) => void,
): void {
  pi.events.on(CONFIG_CHANNEL, (data) => {
    assert.ok(
      isConfigRequest(data),
      "the config channel carries a ConfigRequest",
    );
    handler(data);
  });
}

test("a later config overrides models, model maps and forges key by key, replaces clef, and adds agent roles", () => {
  const merged = mergeConfig(
    {
      clef: { url: "https://a.example/clef" },
      models: {
        primary: ["a/one"],
        agents: { review: "a/one", plan: "a/two" },
        extensions: { btw: "a/one" },
      },
      forges: { "git.a.example": "gitlab" },
      agentRoles: { readOnly: ["a-reader"] },
    },
    {
      clef: { url: "https://b.example/clef" },
      models: {
        agents: { review: "b/one" },
        extensions: { "session-focus": "b/two" },
      },
      forges: { "git.b.example": "github" },
      agentRoles: { readOnly: ["b-reader"], review: ["b-reviewer"] },
    },
  );

  assert.deepEqual(merged, {
    clef: { url: "https://b.example/clef" },
    models: {
      primary: ["a/one"],
      agents: { review: "b/one", plan: "a/two" },
      extensions: { btw: "a/one", "session-focus": "b/two" },
    },
    forges: { "git.a.example": "gitlab", "git.b.example": "github" },
    agentRoles: { readOnly: ["a-reader", "b-reader"], review: ["b-reviewer"] },
  });
});

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-config-")), "pi-extensions.ts");
}

test("a missing user config file reads as empty", async () => {
  assert.deepEqual(
    await readUserConfig(join(tmpdir(), "does-not-exist", "pi-extensions.ts")),
    {},
  );
});

test("the user config is the default export of a TypeScript module, read fresh after an edit", async () => {
  const path = tempConfigPath();
  writeFileSync(
    path,
    'const config = { forges: { "git.example.com": "gitlab" as const } } satisfies object;\nexport default config;\n',
  );
  assert.deepEqual(await readUserConfig(path), {
    forges: { "git.example.com": "gitlab" },
  });

  writeFileSync(
    path,
    'export default { forges: { "git.example.com": "github" } };\n',
  );
  utimesSync(path, new Date(), new Date(Date.now() + 1_000));
  assert.deepEqual(await readUserConfig(path), {
    forges: { "git.example.com": "github" },
  });
});

test("a user config with a wrongly typed field is rejected with the field's path", async () => {
  const path = tempConfigPath();
  writeFileSync(
    path,
    'export default { forges: { "git.example.com": "bitbucket" } };\n',
  );
  await assert.rejects(
    readUserConfig(path),
    /Invalid config from .*\/forges\/git\.example\.com/,
  );
});

test("a user config without a default export is rejected instead of silently dropping settings", async () => {
  const path = tempConfigPath();
  writeFileSync(path, "export const config = {};\n");
  await assert.rejects(readUserConfig(path), /Invalid config from/);
});

test("loadConfig merges what listeners contribute, in registration order, under the user config", async () => {
  const path = tempConfigPath();
  writeFileSync(
    path,
    'export default { models: { subagent: ["user/model"] } };\n',
  );
  await refreshUserConfig(path);
  const pi = fakePi();
  onConfigRequest(pi, (request) => {
    request.contribute({ models: { primary: ["first/model"] } });
  });
  onConfigRequest(pi, (request) => {
    request.contribute({
      models: { primary: ["second/model"], unavailable: "\\b526\\b" },
    });
  });

  const config = loadConfig(pi);

  assert.deepEqual(config.models?.primary, ["second/model"]);
  assert.equal(config.models?.unavailable, "\\b526\\b");
  assert.deepEqual(config.models?.subagent, ["user/model"]);
});

test("an invalid user config leaves no user settings in force", async () => {
  const path = tempConfigPath();
  writeFileSync(
    path,
    'export default { models: { subagent: ["user/model"] } };\n',
  );
  await refreshUserConfig(path);
  writeFileSync(
    path,
    'export default { models: { subagent: "not a list" } };\n',
  );
  utimesSync(path, new Date(), new Date(Date.now() + 2_000));

  await assert.rejects(refreshUserConfig(path), /Invalid config/);
  assert.equal(loadConfig(fakePi()).models?.subagent, undefined);
});

test("subagentForbidden patterns match model refs case-insensitively, and nothing is forbidden without them", () => {
  const models = { subagentForbidden: ["premium", "^expensive/"] };

  assert.equal(
    isForbiddenForSubagents(models, "gateway/model-Premium-5"),
    true,
  );
  assert.equal(isForbiddenForSubagents(models, "expensive/model"), true);
  assert.equal(isForbiddenForSubagents(models, "gateway/cheap"), false);
  assert.equal(
    isForbiddenForSubagents(undefined, "gateway/model-premium-5"),
    false,
  );
});

test("an env model chain keeps only provider/model entries and is absent when empty", () => {
  assert.deepEqual(modelChainFromEnv(" a/one, two ,b/three,"), [
    "a/one",
    "b/three",
  ]);
  assert.equal(modelChainFromEnv(""), undefined);
  assert.equal(modelChainFromEnv(undefined), undefined);
});
