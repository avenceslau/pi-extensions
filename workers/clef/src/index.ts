import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  Integer,
  Literal,
  Object as ObjectType,
  Record as RecordType,
  type Static,
  String as StringType,
  Unknown,
} from "typebox";
import { Check } from "typebox/value";

const MAX_BODY_BYTES = 1_000_000;
const MAX_STATE_CHARACTERS = 200_000;
const MAX_SESSION_SECONDS = 24 * 60 * 60;
const MAX_QUESTIONS = 64;
const BAD_GATEWAY_STATUS = 502;
const PASSTHROUGH_INFERENCE_STATUSES = new Set([400, 422, 429, 503, 504]);

const AccessClaimsType = ObjectType(
  {
    type: Literal("app"),
    email: StringType(),
    exp: Integer(),
    iat: Integer(),
    sub: StringType(),
  },
  { additionalProperties: true },
);

const ClefInputType = ObjectType(
  {
    model: Literal("clef"),
    state: StringType(),
    questions: RecordType(StringType(), Unknown()),
  },
  { additionalProperties: false },
);

type ClefInput = Static<typeof ClefInputType>;

type RequestBodyResult = { body: string } | { response: Response };

interface WorkersAiBinding {
  run(
    model: "@cf/cloudflare/clef",
    input: ClefInput,
    options: {
      returnRawResponse: true;
      gateway: {
        id: string;
        skipCache: true;
        collectLog: false;
      };
    },
  ): Promise<Response>;
}

export interface Env {
  WORKERS_AI: WorkersAiBinding;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  ALLOWED_EMAIL: string;
  AI_GATEWAY_ID: string;
}

let signingKeys:
  | {
      issuer: string;
      keys: ReturnType<typeof createRemoteJWKSet>;
    }
  | undefined;

async function authenticate(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  if (
    !env.ACCESS_TEAM_DOMAIN ||
    !env.ACCESS_AUDIENCE ||
    !env.ALLOWED_EMAIL ||
    !env.AI_GATEWAY_ID
  ) {
    return new Response("Access is not configured", { status: 503 });
  }

  const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");

  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)) {
    return new Response("Invalid Access team domain", { status: 503 });
  }

  const token = request.headers.get("cf-access-jwt-assertion");

  if (!token) {
    return new Response("Authentication required", { status: 401 });
  }

  if (signingKeys?.issuer !== issuer) {
    signingKeys = {
      issuer,
      keys: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
    };
  }

  try {
    const { payload } = await jwtVerify(token, signingKeys.keys, {
      algorithms: ["RS256"],
      issuer,
      audience: env.ACCESS_AUDIENCE,
      requiredClaims: ["exp", "iat", "sub", "email"],
      maxTokenAge: MAX_SESSION_SECONDS,
    });

    if (
      !Check(AccessClaimsType, payload) ||
      payload.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase() ||
      payload.exp - payload.iat > MAX_SESSION_SECONDS
    ) {
      return new Response("Access denied", { status: 403 });
    }
  } catch {
    return new Response("Invalid or expired Access token", { status: 401 });
  }
}

async function readRequestBody(
  stream: ReadableStream<Uint8Array>,
): Promise<RequestBodyResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        return { body: body + decoder.decode() };
      }

      bytes += value.byteLength;

      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();

        return { response: new Response("Request too large", { status: 413 }) };
      }

      body += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function readClefInput(request: Request): Promise<ClefInput | Response> {
  if (new URL(request.url).pathname !== "/") {
    return new Response("Not found", { status: 404 });
  }

  if (request.method !== "POST") {
    return new Response("Use POST", {
      status: 405,
      headers: { allow: "POST" },
    });
  }

  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  ) {
    return new Response("Use application/json", { status: 415 });
  }

  if (!request.body) {
    return new Response("Missing body", { status: 400 });
  }

  const bodyResult = await readRequestBody(request.body);

  if ("response" in bodyResult) {
    return bodyResult.response;
  }

  let parsedInput: unknown;

  try {
    parsedInput = JSON.parse(bodyResult.body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!Check(ClefInputType, parsedInput)) {
    return new Response("Expected clef model, state and questions", {
      status: 400,
    });
  }

  if (parsedInput.state.length > MAX_STATE_CHARACTERS) {
    return new Response("State too large", { status: 413 });
  }

  const questionCount = Object.keys(parsedInput.questions).length;

  if (questionCount === 0 || questionCount > MAX_QUESTIONS) {
    return new Response("Expected 1 to 64 questions", { status: 400 });
  }

  return parsedInput;
}

async function runInference(input: ClefInput, env: Env): Promise<Response> {
  try {
    const inferenceResponse = await env.WORKERS_AI.run(
      "@cf/cloudflare/clef",
      {
        model: "clef",
        state: input.state,
        questions: input.questions,
      },
      {
        returnRawResponse: true,
        gateway: {
          id: env.AI_GATEWAY_ID,
          skipCache: true,
          collectLog: false,
        },
      },
    );

    if (!inferenceResponse.ok) {
      const status = PASSTHROUGH_INFERENCE_STATUSES.has(
        inferenceResponse.status,
      )
        ? inferenceResponse.status
        : BAD_GATEWAY_STATUS;

      return new Response("Clef inference failed", { status });
    }

    return Response.json(await inferenceResponse.json(), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return new Response("Clef inference failed", {
      status: BAD_GATEWAY_STATUS,
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authenticationError = await authenticate(request, env);

    if (authenticationError) {
      return authenticationError;
    }

    const input = await readClefInput(request);

    if (input instanceof Response) {
      return input;
    }

    return runInference(input, env);
  },
} satisfies ExportedHandler<Env>;
