import assert from "node:assert/strict";
import { after, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker, { type Env } from "../src/index.ts";

const issuer = "https://pi-clef-test.cloudflareaccess.com";
const audience = "clef-audience";
const email = "owner@example.com";
const { privateKey, publicKey } = await generateKeyPair("RS256");

const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};

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

type Claims = {
  iss?: string;
  aud?: string[];
  sub?: string;
  email?: string;
  type?: string;
  iat?: number;
  exp?: number;
  nbf?: number;
};

type InferenceCall = Parameters<Env["WORKERS_AI"]["run"]>;

type TestEnvironment = Env & { calls: InferenceCall[] };

async function sign(claims: Claims = {}, key = privateKey) {
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
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(key);
}

function environment(): TestEnvironment {
  const calls: InferenceCall[] = [];

  const workersAi: Env["WORKERS_AI"] = {
    async run(...args) {
      calls.push(args);

      return Response.json(answers);
    },
  };

  return {
    calls,
    WORKERS_AI: workersAi,
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUDIENCE: audience,
    ALLOWED_EMAIL: email,
    AI_GATEWAY_ID: "clef",
  };
}

function request(
  token: string | undefined,
  body = JSON.stringify(input),
  path = "/",
) {
  const headers = new Headers({ "content-type": "application/json" });

  if (token) {
    headers.set("cf-access-jwt-assertion", token);
  }

  return new Request(`https://clef.example.com${path}`, {
    method: "POST",
    headers,
    body,
  });
}

test("authorized request calls only Clef and does not retain code in gateway logs or cache", async () => {
  const env = environment();
  const response = await worker.fetch(request(await sign()), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), answers);
  assert.deepEqual(env.calls, [
    [
      "@cf/cloudflare/clef",
      input,
      {
        returnRawResponse: true,
        gateway: {
          id: "clef",
          skipCache: true,
          collectLog: false,
        },
      },
    ],
  ]);
});

test("missing configuration and missing tokens fail closed without inference", async () => {
  const env = environment();
  assert.equal((await worker.fetch(request(undefined), env)).status, 401);

  const configurationKeys = [
    "ACCESS_TEAM_DOMAIN",
    "ACCESS_AUDIENCE",
    "ALLOWED_EMAIL",
    "AI_GATEWAY_ID",
  ] as const;

  await Promise.all(
    configurationKeys.map(async (key) => {
      const missingConfiguration = environment();
      missingConfiguration[key] = "";

      const response = await worker.fetch(
        request(await sign()),
        missingConfiguration,
      );

      assert.equal(response.status, 503, key);
    }),
  );

  assert.equal(env.calls.length, 0);
});

test("untrusted team URLs never fetch keys", async () => {
  const env = environment();

  const untrustedDomains = [
    "http://localhost",
    "https://evil.example",
    "https://x.cloudflareaccess.com/evil",
  ];

  await Promise.all(
    untrustedDomains.map(async (domain) => {
      const response = await worker.fetch(request(await sign()), {
        ...env,
        ACCESS_TEAM_DOMAIN: domain,
      });

      assert.equal(response.status, 503);
    }),
  );

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

  await Promise.all(
    claims.map(async (claim) => {
      assert.equal(
        (await worker.fetch(request(await sign(claim)), env)).status,
        401,
      );
    }),
  );

  const other = await generateKeyPair("RS256");
  assert.equal(
    (await worker.fetch(request(await sign({}, other.privateKey)), env)).status,
    401,
  );
  assert.equal((await worker.fetch(request("not-a-jwt"), env)).status, 401);
  assert.equal(env.calls.length, 0);
});

test("wrong identity, service tokens and lifetimes longer than 24h are forbidden", async () => {
  const env = environment();

  const forbiddenClaims = [
    { email: "attacker@example.com" },
    { type: "service" },
    { exp: Math.floor(Date.now() / 1000) + 86401 },
  ];

  await Promise.all(
    forbiddenClaims.map(async (claims) => {
      assert.equal(
        (await worker.fetch(request(await sign(claims)), env)).status,
        403,
      );
    }),
  );

  assert.equal(env.calls.length, 0);
});

test("only POST JSON on the root path is supported", async () => {
  const env = environment();
  const token = await sign();
  assert.equal(
    (await worker.fetch(request(token, undefined, "/other"), env)).status,
    404,
  );

  const get = new Request("https://clef.example.com/", {
    headers: { "cf-access-jwt-assertion": token },
  });

  assert.equal((await worker.fetch(get, env)).status, 405);
  const text = request(token);
  text.headers.set("content-type", "text/plain");
  assert.equal((await worker.fetch(text, env)).status, 415);
  assert.equal(env.calls.length, 0);
});

test("malformed bodies and model or gateway overrides never call AI", async () => {
  const env = environment();
  const token = await sign();

  const malformedBodies = [
    "{",
    "null",
    JSON.stringify({ ...input, model: "clef-flash" }),
    JSON.stringify({ ...input, model: "@cf/other/model" }),
    JSON.stringify({ ...input, options: { gateway: { id: "other" } } }),
    JSON.stringify({ ...input, state: 1 }),
    JSON.stringify({ ...input, questions: [] }),
    JSON.stringify({ ...input, questions: {} }),
    JSON.stringify({
      ...input,
      questions: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [index, {}]),
      ),
    }),
  ];

  await Promise.all(
    malformedBodies.map(async (body) => {
      assert.equal((await worker.fetch(request(token, body), env)).status, 400);
    }),
  );

  assert.equal(env.calls.length, 0);
});

test("oversized streamed bodies and states are rejected", async () => {
  const env = environment();
  const token = await sign();
  const large = JSON.stringify({ ...input, state: "x".repeat(200001) });
  assert.equal((await worker.fetch(request(token, large), env)).status, 413);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(500001));
      controller.enqueue(new Uint8Array(500001));
      controller.close();
    },
  });

  const streamedOptions: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      "cf-access-jwt-assertion": token,
      "content-type": "application/json",
      "content-length": "1",
    },
    body: stream,
    duplex: "half",
  };

  const streamed = new Request("https://clef.example.com/", streamedOptions);

  assert.equal((await worker.fetch(streamed, env)).status, 413);
  assert.equal(env.calls.length, 0);
});

test("upstream token-limit and rate-limit status codes survive without leaking details", async () => {
  const token = await sign();

  await Promise.all(
    [422, 429].map(async (status) => {
      const env = environment();
      env.WORKERS_AI.run = async () =>
        new Response("sensitive provider details", { status });
      const response = await worker.fetch(request(token), env);
      assert.equal(response.status, status);
      assert.equal(await response.text(), "Clef inference failed");
    }),
  );
});

test("inference failures do not expose provider errors or credentials", async () => {
  const env = environment();
  env.WORKERS_AI.run = async () => {
    throw new Error("sensitive provider details");
  };

  const response = await worker.fetch(request(await sign()), env);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "Clef inference failed");
});
