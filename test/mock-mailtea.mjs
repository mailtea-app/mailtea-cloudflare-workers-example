/**
 * A tiny stand-in for the Mailtea API, so this example's tests run with no
 * credentials and no network. It records every request it receives, which is
 * what the assertions read.
 *
 * Point the SDK (or fetch) at `server.url` to use it.
 */
import { createServer } from "node:http";

const EMAIL_ID = "txemail_00000000000000000000000000000000";

export async function startMockMailtea() {
  /** @type {Array<{method: string, path: string, authorization: string | null, body: any}>} */
  const requests = [];

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }

      const url = new URL(req.url ?? "/", "http://mock");
      requests.push({
        method: req.method ?? "GET",
        path: url.pathname,
        authorization: req.headers.authorization ?? null,
        body
      });

      const send = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      // Auth is checked first, the same way the real API does it — an example
      // that forgets the key should fail its test, not silently "send".
      if (!String(req.headers.authorization ?? "").startsWith("Bearer ")) {
        return send(401, { error: "Unauthorized" });
      }

      const route = `${req.method} ${url.pathname}`;

      if (route === "POST /v1/emails") return send(200, { id: EMAIL_ID });
      if (route === "POST /v1/emails/batch") {
        const items = Array.isArray(body) ? body : [];
        return send(200, {
          data: items.map((_, index) => ({
            id: `txemail_${String(index).padStart(32, "0")}`
          }))
        });
      }
      if (req.method === "GET" && /^\/v1\/emails\/[^/]+$/.test(url.pathname)) {
        return send(200, {
          object: "email",
          id: url.pathname.split("/").pop(),
          last_event: "delivered",
          subject: "Mock email",
          created_at: "2026-01-01T00:00:00.000Z"
        });
      }
      if (route === "GET /v1/emails") {
        return send(200, {
          object: "list",
          data: [],
          total: 0,
          limit: 20,
          offset: 0,
          has_more: false
        });
      }
      if (req.method === "PATCH" && /^\/v1\/emails\/[^/]+$/.test(url.pathname)) {
        return send(200, { object: "email", id: url.pathname.split("/").pop() });
      }
      // Cancel is POST /v1/emails/:id/cancel. There is no DELETE on emails —
      // the real API does not define one (apps/api/src/email-rest.ts).
      if (req.method === "POST" && /^\/v1\/emails\/[^/]+\/cancel$/.test(url.pathname)) {
        return send(200, { object: "email", id: url.pathname.split("/")[3] });
      }
      if (route === "POST /v1/contacts") {
        return send(200, { id: "con_00000000000000000000000000000000" });
      }
      if (route === "GET /v1/contacts") {
        return send(200, { object: "list", data: [], total: 0, limit: 20, offset: 0, has_more: false });
      }
      if (route === "POST /v1/topics") {
        return send(200, { id: "top_00000000000000000000000000000000", name: body?.name ?? "Topic" });
      }
      if (route === "GET /v1/topics") {
        return send(200, { object: "list", data: [], total: 0, limit: 20, offset: 0, has_more: false });
      }
      if (route === "POST /v1/posts") {
        return send(200, { id: "post_00000000000000000000000000000000" });
      }
      if (req.method === "POST" && /^\/v1\/posts\/[^/]+\/send$/.test(url.pathname)) {
        return send(200, { id: url.pathname.split("/")[3], status: "sending" });
      }

      return send(404, { error: "Not Found", path: url.pathname });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** The most recent request, which is what most assertions want. */
    get last() {
      return requests.at(-1);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
