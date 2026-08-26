# Mailtea + Cloudflare Workers Example

This example shows how to use [Mailtea](https://mailtea.app) with Cloudflare
Workers to send email from a `POST /send` endpoint running at the edge.

## Prerequisites

To get the most out of this guide, you'll need to:

- [Create an API key](https://studio.mailtea.app/api-keys)
- [Verify your domain](https://docs.mailtea.app/docs/documentation/domains)

## Instructions

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.dev.vars.example` to `.dev.vars` and add your API key:
   ```bash
   cp .dev.vars.example .dev.vars
   ```
   `wrangler dev` loads `.dev.vars` as bindings. Keep it to secrets — every name
   in it shadows the same name in `[vars]`. For a deployed Worker, set the key
   as a secret instead; it never belongs in `wrangler.toml`:
   ```bash
   wrangler secret put MAILTEA_API_KEY
   ```
3. Set `MAILTEA_FROM` in the `[vars]` block of `wrangler.toml` to an address on
   your verified domain — it is not a secret, and it is read the same way in
   local dev and in production. Then run it:
   ```bash
   npm run dev
   ```
4. Send an email:
   ```bash
   curl -X POST http://localhost:8787/send \
     -H "content-type: application/json" \
     -d '{"to":"reader@example.com","subject":"Hello","html":"<p>Hi there.</p>"}'
   ```
   ```json
   { "id": "txemail_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" }
   ```

Deploy it with `npm run deploy`.

## Reading the API key on Workers

Workers have no `.env` file and no ambient `process.env` — with no
`nodejs_compat` flag, `process` is not defined at all. Every var and secret
arrives instead as the `env` argument of `fetch`:

```js
export default {
  async fetch(request, env) {
    const mailtea = new Mailtea(env.MAILTEA_API_KEY, { ... });
  }
};
```

Because `env` only exists once a request is in flight, the client is built
per request rather than once at module scope. That costs nothing — the
constructor just stores the key and base URL.

Two things this example ran into that are easy to miss:

- **`nodejs_compat` is required, and so is a recent `compatibility_date`.**
  `mailtea-sdk` imports `crypto` — unprefixed, not `node:crypto` — for its
  webhook-signature helpers. An unprefixed built-in needs the flag *and* a
  `compatibility_date` of 2024-09-23 or later; miss either and the build fails
  with `Could not resolve "crypto"`, even though the send path is pure `fetch`.
- **`fetch` must stay bound.** The SDK stores the `fetch` it is given and calls
  it bare. Node tolerates that; the Workers runtime throws `Illegal invocation`.
  Passing `fetch: globalThis.fetch.bind(globalThis)` is the fix.

## What this example covers

- Reading a Mailtea API key from a Worker `env` binding, not `process.env`
- Constructing the SDK client per request, since `env` is a request-scoped argument
- Sending mail with `mailtea.emails.send()` from `POST /send`
- Passing a Mailtea error's own status back to the caller, so 401 / 422 / 429 stay meaningful
- Answering 502 when Mailtea is unreachable, instead of letting the Worker throw an opaque `Error 1101`
- Keeping the key out of source control with `.dev.vars` locally and `wrangler secret put` in production

## Tests

```bash
npm test
```

The tests call the exported `fetch` handler directly with a `Request` and a
fake `env`, so they need no Cloudflare account and no `wrangler`. They run
against a bundled mock Mailtea server, so they need no API key and make no
network calls.

## Learn more

- [Documentation](https://docs.mailtea.app)
- [API reference](https://docs.mailtea.app/docs/api-reference)
- [Node.js SDK](https://github.com/mailtea-app/mailtea-node) ·
  [Python SDK](https://github.com/mailtea-app/mailtea-python) ·
  [MCP server](https://github.com/mailtea-app/mailtea-mcp)
