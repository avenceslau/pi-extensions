# Clef-only Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/avenceslau/pi-extensions/tree/main/workers/clef)

Run the Pi extensions' Clef checks on your own Cloudflare account, without putting a Cloudflare API token in Pi:

```text
Pi → Cloudflare Access (24-hour user session) → this Worker → Workers AI / AI Gateway → Clef
```

The Worker accepts `POST /` with Clef's `{ model: "clef", state, questions }` body and returns its answers unchanged.
It calls only `@cf/cloudflare/clef`, never a caller-selected model or gateway. Requests are limited to 1 MB,
200,000 state characters, and 64 questions. Upstream 422 responses are preserved so Pi can retry a shorter state.

## Deploy and protect

The button deploys the Worker and Workers AI binding; **it does not provision Access**. This directory is
self-contained because the button copies it as a new repository's root. The button works once this directory
is published on GitHub's `main` branch.

1. Click **Deploy to Cloudflare**, or deploy from a checkout:

   ```sh
   cd workers/clef
   npm ci
   npx wrangler login
   npm run deploy
   ```

   Use a Cloudflare account with Workers AI enabled. Inference is billed to that account. The Worker returns
   **503 without running inference** until the Access variables below are configured.

2. In **Workers & Pages → pi-clef → Access**, enable **Protect this Worker behind Access → All traffic**.
   On dashboards exposing this under **Settings → Domains & Routes**, enable Access for the `workers.dev`
   hostname. Do not leave an alternate route unprotected. Preview URLs are disabled in `wrangler.jsonc`.

3. Edit the resulting application in **Zero Trust → Access controls → Applications**:
   - Create an **Allow** policy including only the email address you want to authorize.
   - Set both the application's and the policy's session durations to **24 hours**.
   - Enable an identity provider you can use, such as email one-time PIN or Google login.
   - Do not add Everyone, Bypass, or Service Auth policies. This Worker requires a human user's email claim.
   - Copy the application's **Application Audience (AUD) Tag** and your team's
     `https://<team>.cloudflareaccess.com` URL.

4. In the Worker's **Settings → Variables and Secrets**, add these **runtime text variables**, then deploy
   the configuration change:

   | Variable | Value |
   | --- | --- |
   | `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` |
   | `ACCESS_AUDIENCE` | The Access application's AUD tag |
   | `ALLOWED_EMAIL` | The same exact email as the Allow policy |

   They are identifiers, not credentials. `keep_vars: true` preserves these dashboard-managed values on later
   CLI deploys. Missing values always deny requests. The Worker validates the JWT signature, issuer, audience,
   expiration, issue time, application-token type and email; it also rejects token lifetimes exceeding 24 hours.
   An unsigned email header is never trusted, even on an alternate hostname.

5. `AI_GATEWAY_ID` defaults to `default`, which Cloudflare creates on the first authenticated inference request.
   To use a dedicated gateway, create one in the same account and change `AI_GATEWAY_ID` in `wrangler.jsonc`
   before deploying. Configure rate limits and any desired spending controls in Cloudflare. Request logging and
   response caching are disabled in the Worker (`collectLog: false`, `skipCache: true`) to avoid retaining code
   review contents; Worker observability is also disabled. There is no built-in application spending cap.

## Connect Pi

Install `cloudflared` on the computer running Pi (`brew install cloudflared` on macOS), then sign in from an
interactive terminal using the **actual deployed Worker URL**:

```sh
cloudflared access login https://pi-clef.<your-subdomain>.workers.dev
```

Sign in with the email allowed above. The login command can print a JWT: treat its output as a credential and do
not paste it into chats, issues or source files.

Add this to the default export of `~/.pi/agent/pi-extensions.ts`, preserving any existing configuration:

```ts
export default {
  clef: {
    url: "https://pi-clef.<your-subdomain>.workers.dev/",
    model: "clef",
    auth: {
      header: "cf-access-token",
      command: [
        "cloudflared",
        "access",
        "token",
        "--app",
        "https://pi-clef.<your-subdomain>.workers.dev",
      ],
    },
  },
};
```

Use the same scheme and hostname for `url`, `--app` and the login command. Pi sends the raw Access JWT using
`cf-access-token`; Access validates it and supplies `Cf-Access-Jwt-Assertion` to the Worker. Do not add `Bearer`.
The extension reuses the JWT until five minutes before expiry, then asks `cloudflared` for a token again.
This does **not** silently mint daily API keys or guarantee unattended renewal: when the Access session expires,
run `cloudflared access login` again. Interactive login must happen outside Pi's 30-second token-command timeout.
Run `/reload` in Pi after changing the configuration.

## Verify

- An unauthenticated request must never return model answers: Access normally returns a login redirect or 401.
- Signing in as another email must be denied.
- After login, run `/hygiene` on a small code diff in Pi; Clef should return scores instead of an auth failure.
- With Access misconfigured or bypassed, the Worker's own JWT checks must still reject unauthorized traffic.
- Do not enable preview URLs unless their Access application and audience are configured deliberately.

For local, network-free tests and a deployment build:

```sh
npm ci
npm test
npm run check
npm run deploy -- --dry-run
```

Tests sign real JWTs and use a local mock JWKS response and AI binding. They cover expired/wrongly signed tokens,
wrong audiences, unauthorized emails, long-lived and non-user tokens, missing configuration, route/method/input
limits, fixed model selection, and sanitized inference failures. `wrangler dev` is not an anonymous development
bypass; the Worker still requires valid Access credentials. Workers AI development calls can incur charges.

References: [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/),
[Worker Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/),
[Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[session durations](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/).
