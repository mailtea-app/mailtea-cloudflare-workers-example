import { Mailtea, MailteaError } from "mailtea-sdk";

/**
 * On Workers, configuration arrives as the `env` argument of `fetch` — plain
 * vars from `wrangler.toml` and secrets set with `wrangler secret put` alike.
 * There is no ambient `process` at all unless `nodejs_compat` is enabled (this
 * Worker enables it, but only because the SDK imports `node:crypto`), so `env`
 * is the binding source that always works.
 *
 * `env` only exists once a request is in flight, which is why the client is
 * built per request rather than once at module scope. Constructing it is cheap:
 * it stores the key and base URL and does no I/O.
 */
function mailteaFor(env) {
  return new Mailtea(env.MAILTEA_API_KEY, {
    // Only needed for local dev or a self-hosted Mailtea. Omit in production.
    baseUrl: env.MAILTEA_API_BASE_URL,
    // The SDK stores whatever `fetch` it is given and calls it bare. Node and
    // browsers tolerate that; the Workers runtime rejects a `fetch` that has
    // lost its global `this` with "Illegal invocation", so hand it a bound one.
    fetch: globalThis.fetch.bind(globalThis)
  });
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname !== "/send") {
      return json({ error: "Not Found" }, 404);
    }
    if (request.method !== "POST") {
      return json({ error: "Method Not Allowed" }, 405, { allow: "POST" });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Request body must be JSON" }, 400);
    }

    const { to, subject, html } = payload ?? {};
    if (!to || !subject || !html) {
      return json({ error: "`to`, `subject`, and `html` are required" }, 400);
    }

    try {
      const { id } = await mailteaFor(env).emails.send({
        from: env.MAILTEA_FROM,
        to,
        subject,
        html
      });

      return json({ id }, 202);
    } catch (error) {
      if (error instanceof MailteaError) {
        // `status: 0` means the request never left the Worker — a missing key or
        // some other misconfiguration, which is this Worker's fault, not the
        // caller's. Everything else is Mailtea's own status, and passing it
        // through keeps 401 / 422 / 429 meaningful to whoever called us.
        const status = error.status || 500;
        return json({ error: error.message, code: error.code }, status);
      }

      // A transport failure — connection refused, DNS, TLS, or a Worker
      // subrequest limit — rejects as a plain `TypeError`, not a
      // `MailteaError`: the SDK only wraps responses it actually received.
      // Rethrowing would hand the caller an opaque `Error 1101` with no body,
      // so answer with a status that says who failed. The cause goes to
      // `wrangler tail`, never to the caller.
      console.error("Mailtea send failed:", error);
      return json({ error: "Could not reach Mailtea", code: "upstream_unreachable" }, 502);
    }
  }
};
