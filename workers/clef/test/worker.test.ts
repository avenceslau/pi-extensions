import assert from "node:assert/strict";
import { after, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../src/index.ts";

const issuer = "https://pi-clef-test.cloudflareaccess.com";
const audience = "clef-audience";
const email = "owner@example.com";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
  return Response.json({ keys: [jwk] });
};
after(() => {
  globalThis.fetch = originalFetch;
});

const input = {
  model: "clef",
  state: "The tests pass.",
  questions: {
    passing: {
      type: "noul",
      instructions: "Are tests passing?",
      criteria: { true: "Tests pass", false: "Tests fail" },
    },
  },
};
const answers = { answers: { passing: { noul: 0.95 } } };

async function sign(claims: Record<string, unknown> = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: [audience],
    sub: "owner-id",
    email,
    type: "app",
    iat: now,
    exp: now + 86400,
    ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(key);
}

function environment() {
  const calls: unknown[][] = [];
  return {
    calls,
    AI: {
      async run(...args: unknown[]) {
        calls.push(args);
        return Response.json(answers);
      },
    },
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUDIENCE: audience,
    ALLOWED_EMAIL: email,
    AI_GATEWAY_ID: "clef",
  };
}

function request(token: string | undefined, body = JSON.stringify(input), path = "/") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers["cf-access-jwt-assertion"] = token;
  }
  return new Request(`https://clef.example.com${path}`, {
    method: "POST",
    headers,
    body,
  });
}

test("authorized request calls only Clef and does not retain code in gateway logs or cache", async () => {
  const env = environment();
  const response = await worker.fetch(request(await sign()), env as never);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), answers);
  assert.deepEqual(env.calls, [[
    "@cf/cloudflare/clef",
    input,
    { returnRawResponse: true, gateway: { id: "clef", skipCache: true, collectLog: false } },
  ]]);
});

test("missing configuration and missing tokens fail closed without inference", async () => {
  const env = environment();
  assert.equal((await worker.fetch(request(undefined), env as never)).status, 401);
  for (const key of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUDIENCE", "ALLOWED_EMAIL", "AI_GATEWAY_ID"]) {
    const response = await worker.fetch(request(await sign()), { ...env, [key]: "" } as never);
    assert.equal(response.status, 503, key);
  }
  assert.equal(env.calls.length, 0);
});

test("untrusted team URLs never fetch keys", async () => {
  const env = environment();
  for (const domain of ["http://localhost", "https://evil.example", "https://x.cloudflareaccess.com/evil"]) {
    const response = await worker.fetch(request(await sign()), {
      ...env,
      ACCESS_TEAM_DOMAIN: domain,
    } as never);
    assert.equal(response.status, 503);
  }
  assert.equal(env.calls.length, 0);
});

test("invalid signature, issuer, audience, expiration and future tokens never call AI", async () => {
  const env = environment();
  const now = Math.floor(Date.now() / 1000);
  const claims = [
    { iss: "https://other.cloudflareaccess.com" },
    { aud: ["other-application"] },
    { exp: now - 10 },
    { iat: now + 60, nbf: now + 60 },
    { exp: undefined },
    { iat: undefined },
    { sub: undefined },
    { email: undefined },
    { iat: now - 86401, exp: now + 60 },
  ];
  for (const claim of claims) {
    assert.equal((await worker.fetch(request(await sign(claim)), env as never)).status, 401);
  }
  const other = await generateKeyPair("RS256");
  assert.equal((await worker.fetch(request(await sign({}, other.privateKey)), env as never)).status, 401);
  assert.equal((await worker.fetch(request("not-a-jwt"), env as never)).status, 401);
  assert.equal(env.calls.length, 0);
});

test("wrong identity, service tokens and lifetimes longer than 24h are forbidden", async () => {
  const env = environment();
  for (const claims of [
    { email: "attacker@example.com" },
    { type: "service" },
    { exp: Math.floor(Date.now() / 1000) + 86401 },
  ]) {
    assert.equal((await worker.fetch(request(await sign(claims)), env as never)).status, 403);
  }
  assert.equal(env.calls.length, 0);
});

test("only POST JSON on the root path is supported", async () => {
  const env = environment();
  const token = await sign();
  assert.equal((await worker.fetch(request(token, undefined, "/other"), env as never)).status, 404);
  const get = new Request("https://clef.example.com/", {
    headers: { "cf-access-jwt-assertion": token },
  });
  assert.equal((await worker.fetch(get, env as never)).status, 405);
  const text = request(token);
  text.headers.set("content-type", "text/plain");
  assert.equal((await worker.fetch(text, env as never)).status, 415);
  assert.equal(env.calls.length, 0);
});

test("malformed bodies and model or gateway overrides never call AI", async () => {
  const env = environment();
  const token = await sign();
  for (const body of [
    "{",
    "null",
    JSON.stringify({ ...input, model: "clef-flash" }),
    JSON.stringify({ ...input, model: "@cf/other/model" }),
    JSON.stringify({ ...input, options: { gateway: { id: "other" } } }),
    JSON.stringify({ ...input, state: 1 }),
    JSON.stringify({ ...input, questions: [] }),
    JSON.stringify({ ...input, questions: {} }),
    JSON.stringify({ ...input, questions: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [i, {}])) }),
  ]) {
    assert.equal((await worker.fetch(request(token, body), env as never)).status, 400);
  }
  assert.equal(env.calls.length, 0);
});

test("oversized streamed bodies and states are rejected", async () => {
  const env = environment();
  const token = await sign();
  const large = JSON.stringify({ ...input, state: "x".repeat(200001) });
  assert.equal((await worker.fetch(request(token, large), env as never)).status, 413);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(500001));
      controller.enqueue(new Uint8Array(500001));
      controller.close();
    },
  });
  const streamed = new Request("https://clef.example.com/", {
    method: "POST",
    headers: { "cf-access-jwt-assertion": token, "content-type": "application/json", "content-length": "1" },
    body: stream,
    duplex: "half",
  } as RequestInit);
  assert.equal((await worker.fetch(streamed, env as never)).status, 413);
  assert.equal(env.calls.length, 0);
});

test("upstream token-limit and rate-limit status codes survive without leaking details", async () => {
  const env = environment();
  const token = await sign();
  for (const status of [422, 429]) {
    env.AI.run = async () => new Response("sensitive provider details", { status });
    const response = await worker.fetch(request(token), env as never);
    assert.equal(response.status, status);
    assert.equal(await response.text(), "Clef inference failed");
  }
});

test("inference failures do not expose provider errors or credentials", async () => {
  const env = environment();
  env.AI.run = async () => {
    throw new Error("sensitive provider details");
  };
  const response = await worker.fetch(request(await sign()), env as never);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Clef inference failed");
});
