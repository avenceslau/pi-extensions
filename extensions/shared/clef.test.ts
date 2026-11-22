import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { askClef, askClefInBatches, type ClefQuestion } from "./clef.ts";

const QUESTION: ClefQuestion = {
  type: "noul",
  instructions: "Is it risky?",
  criteria: { true: "risky", false: "safe" },
};

interface ReceivedRequest {
  headers: IncomingHttpHeaders;
  model: unknown;
}

// `envelope` answers like the Workers AI REST API, which wraps the model's output in `{ result, success, errors }`.
async function withClefServer(
  run: (url: string, requests: ReceivedRequest[]) => Promise<void>,
  { envelope = false } = {},
): Promise<void> {
  const requests: ReceivedRequest[] = [];

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push({ headers: request.headers, model: parsed.model });
      const answers = {
        answers: Object.fromEntries(
          Object.keys(parsed.questions).map((key) => [key, { noul: 0.9 }]),
        ),
      };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          envelope
            ? { result: answers, success: true, errors: [], messages: [] }
            : answers,
        ),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(
      typeof address === "object" && address !== null,
      "the server listens on a TCP port",
    );
    await run(`http://127.0.0.1:${address.port}/clef`, requests);
  } finally {
    server.close();
  }
}

test("askClef sends the token printed by the configured command in the configured header", async () => {
  await withClefServer(async (url, requests) => {
    const { scores } = await askClef(
      {
        url,
        auth: { header: "x-clef-token", command: ["echo", "secret-token"] },
      },
      "diff",
      { risky: QUESTION },
    );

    assert.equal(scores.risky, 0.9);
    assert.equal(requests[0].headers["x-clef-token"], "secret-token");
  });
});

test("askClef sends a static token and sends no auth header without auth", async () => {
  await withClefServer(async (url, requests) => {
    await askClef(
      { url, auth: { header: "authorization", token: "Bearer abc" } },
      "diff",
      { risky: QUESTION },
    );
    await askClef({ url }, "diff", { risky: QUESTION });

    assert.equal(requests[0].headers.authorization, "Bearer abc");
    assert.equal(requests[1].headers.authorization, undefined);
  });
});

test("askClef reads answers from the Workers AI REST envelope and sends the configured model", async () => {
  await withClefServer(
    async (url, requests) => {
      const { scores } = await askClef({ url, model: "clef-flash" }, "diff", {
        risky: QUESTION,
      });
      await askClef({ url }, "diff", { risky: QUESTION });

      assert.equal(scores.risky, 0.9);
      assert.deepEqual(
        requests.map((request) => request.model),
        ["clef-flash", "clef"],
      );
    },
    { envelope: true },
  );
});

test("askClef refuses to run without a Clef config", async () => {
  await assert.rejects(
    askClef(undefined, "diff", { risky: QUESTION }),
    /Clef is not configured/,
  );
});

test("askClefInBatches counts every call as failed when the token command fails", async () => {
  const result = await askClefInBatches(
    {
      url: "http://127.0.0.1:9/clef",
      auth: { header: "x-clef-token", command: ["false"] },
    },
    [{ state: "diff", questions: [QUESTION, QUESTION] }],
  );

  assert.equal(result.calls, 1);
  assert.equal(result.failures, 1);
  assert.equal(result.answers[0].length, 2);
  assert.equal(
    result.answers[0].filter((answer) => answer !== undefined).length,
    0,
  );
});
