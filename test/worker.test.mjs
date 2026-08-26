import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { startMockMailtea } from "./mock-mailtea.mjs";

let mock;

/** A loopback URL whose port is bound and released, so it refuses connections. */
async function closedPortUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/**
 * The Worker only ever sees `env`, so the test supplies one directly. No
 * `wrangler`, no Cloudflare account, no network beyond the mock on loopback.
 */
function testEnv(overrides = {}) {
  return {
    MAILTEA_API_KEY: "mt_pat_test_key",
    MAILTEA_API_BASE_URL: mock.url,
    MAILTEA_FROM: "Acme <hello@acme.com>",
    ...overrides
  };
}

function sendRequest(body) {
  return new Request("https://worker.example/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

before(async () => {
  mock = await startMockMailtea();
});

after(async () => {
  await mock.close();
});

test("POST /send sends the email through Mailtea and returns its id", async () => {
  const response = await worker.fetch(
    sendRequest({
      to: "reader@mailtea.dev",
      subject: "Hello from a Worker",
      html: "<p>Sent from the edge.</p>"
    }),
    testEnv()
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    id: "txemail_00000000000000000000000000000000"
  });

  const sent = mock.last;
  assert.equal(sent.method, "POST");
  assert.equal(sent.path, "/v1/emails");
  assert.equal(sent.authorization, "Bearer mt_pat_test_key");
  assert.equal(sent.body.from, "Acme <hello@acme.com>");
  assert.equal(sent.body.to, "reader@mailtea.dev");
  assert.equal(sent.body.subject, "Hello from a Worker");
  assert.equal(sent.body.html, "<p>Sent from the edge.</p>");
});

test("the key comes from env, not process.env", async () => {
  // The SDK falls back to `process.env.MAILTEA_API_KEY` when no key is passed
  // in. A decoy there proves the Worker is reading its `env` binding rather
  // than whatever the ambient environment happens to hold.
  process.env.MAILTEA_API_KEY = "mt_pat_process_env_decoy";
  try {
    const response = await worker.fetch(
      sendRequest({ to: "reader@mailtea.dev", subject: "Binding", html: "<p>Hi</p>" }),
      testEnv({ MAILTEA_API_KEY: "mt_pat_binding_key" })
    );

    assert.equal(response.status, 202);
    assert.equal(mock.last.authorization, "Bearer mt_pat_binding_key");
  } finally {
    delete process.env.MAILTEA_API_KEY;
  }
});

test("a missing API key fails as a 500 without calling Mailtea", async () => {
  const before = mock.requests.length;

  const response = await worker.fetch(
    sendRequest({ to: "reader@mailtea.dev", subject: "No key", html: "<p>Hi</p>" }),
    testEnv({ MAILTEA_API_KEY: undefined })
  );

  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, "missing_api_key");
  assert.equal(mock.requests.length, before, "no request should reach Mailtea");
});

test("a Mailtea error is surfaced with its own status", async () => {
  // The mock 404s on unknown routes; pointing the base URL at a subpath makes
  // the send miss /v1/emails, which is the shape of any upstream failure.
  const response = await worker.fetch(
    sendRequest({ to: "reader@mailtea.dev", subject: "Broken", html: "<p>Hi</p>" }),
    testEnv({ MAILTEA_API_BASE_URL: `${mock.url}/nope` })
  );

  assert.equal(response.status, 404);
  assert.ok((await response.json()).error);
});

test("the SDK is handed a fetch that survives losing its `this`", async () => {
  // These tests run on Node, where a detached `fetch` works fine — so without
  // this one, deleting `fetch: globalThis.fetch.bind(globalThis)` from the
  // Worker keeps every other test green while the deployed Worker dies with
  // "Illegal invocation". Standing in a fetch that enforces the same `this`
  // check workerd does makes that regression fail here instead of in prod.
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(...args) {
    if (this !== globalThis) {
      throw new TypeError(
        "Illegal invocation: function called with incorrect `this` reference."
      );
    }
    return realFetch.apply(globalThis, args);
  };

  try {
    const response = await worker.fetch(
      sendRequest({ to: "reader@mailtea.dev", subject: "Bound", html: "<p>Hi</p>" }),
      testEnv()
    );

    assert.equal(response.status, 202, await response.text());
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an unreachable Mailtea becomes a 502, not an unhandled throw", async () => {
  // A transport failure rejects as a plain TypeError, not a MailteaError. If
  // the Worker rethrows it, workerd answers with an opaque `Error 1101` and no
  // body. Binding a port and closing it again yields one that is certain to
  // refuse the connection.
  const deadUrl = await closedPortUrl();

  // The Worker logs the cause for `wrangler tail`; keep it out of test output.
  const realError = console.error;
  console.error = () => {};

  try {
    const response = await worker.fetch(
      sendRequest({ to: "reader@mailtea.dev", subject: "Down", html: "<p>Hi</p>" }),
      testEnv({ MAILTEA_API_BASE_URL: deadUrl })
    );

    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "upstream_unreachable");
  } finally {
    console.error = realError;
  }
});

test("bad requests are rejected before any send", async () => {
  const before = mock.requests.length;
  const env = testEnv();

  const missingFields = await worker.fetch(sendRequest({ to: "reader@mailtea.dev" }), env);
  assert.equal(missingFields.status, 400);

  const notJson = await worker.fetch(
    new Request("https://worker.example/send", { method: "POST", body: "not json" }),
    env
  );
  assert.equal(notJson.status, 400);

  const wrongMethod = await worker.fetch(new Request("https://worker.example/send"), env);
  assert.equal(wrongMethod.status, 405);

  const wrongPath = await worker.fetch(new Request("https://worker.example/"), env);
  assert.equal(wrongPath.status, 404);

  assert.equal(mock.requests.length, before, "no request should reach Mailtea");
});
