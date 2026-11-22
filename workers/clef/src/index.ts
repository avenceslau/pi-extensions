import { createRemoteJWKSet, jwtVerify } from "jose";

interface Env {
  AI: Ai<{
    "@cf/cloudflare/clef": {
      inputs: {
        model: "clef";
        state: string;
        questions: Record<string, unknown>;
      };
      postProcessedOutputs: { answers: Record<string, unknown> };
    };
  }>;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  ALLOWED_EMAIL: string;
  AI_GATEWAY_ID: string;
}

const MAX_BODY_BYTES = 1_000_000;
const MAX_STATE_CHARACTERS = 200_000;
const MAX_SESSION_SECONDS = 24 * 60 * 60;
let signingKeys: {
  issuer: string;
  keys: ReturnType<typeof createRemoteJWKSet>;
} | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        payload.type !== "app" ||
        typeof payload.email !== "string" ||
        payload.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase() ||
        payload.exp! - payload.iat! > MAX_SESSION_SECONDS
      ) {
        return new Response("Access denied", { status: 403 });
      }
    } catch {
      return new Response("Invalid or expired Access token", { status: 401 });
    }

    if (new URL(request.url).pathname !== "/") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST") {
      return new Response("Use POST", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
      return new Response("Use application/json", { status: 415 });
    }
    if (!request.body) {
      return new Response("Missing body", { status: 400 });
    }

    // Count streamed bytes: Content-Length can be absent or forged.
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          await reader.cancel();
          return new Response("Request too large", { status: 413 });
        }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      reader.releaseLock();
    }

    let input;
    try {
      input = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (
      !input ||
      input.model !== "clef" ||
      typeof input.state !== "string" ||
      !input.questions ||
      typeof input.questions !== "object" ||
      Array.isArray(input.questions) ||
      Object.keys(input).some((key) => !["model", "state", "questions"].includes(key))
    ) {
      return new Response("Expected clef model, state and questions", { status: 400 });
    }
    if (input.state.length > MAX_STATE_CHARACTERS) {
      return new Response("State too large", { status: 413 });
    }
    const questions = Object.values(input.questions);
    if (questions.length === 0 || questions.length > 64) {
      return new Response("Expected 1 to 64 questions", { status: 400 });
    }

    try {
      const result = await env.AI.run(
        "@cf/cloudflare/clef",
        { model: "clef", state: input.state, questions: input.questions },
        {
          returnRawResponse: true,
          gateway: {
            id: env.AI_GATEWAY_ID,
            skipCache: true,
            collectLog: false,
          },
        },
      );
      if (!result.ok) {
        const status = [400, 422, 429, 503, 504].includes(result.status) ? result.status : 502;
        return new Response("Clef inference failed", { status });
      }
      return Response.json(await result.json(), { headers: { "cache-control": "no-store" } });
    } catch {
      return new Response("Clef inference failed", { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
