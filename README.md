# @mirafive/sdk-server

Send events and read feature flags from your server — Node, Bun, Deno, Cloudflare
Workers, Vercel and other edge runtimes. Privacy-first analytics and feature flags from
MIRA FIVE, hosted in the EU.

## Size

| Import | min + gzip |
|---|---|
| `@mirafive/sdk-server` | 3.52 kB |
| `@mirafive/sdk-server/flags` | 3.88 kB |

Both together are about 6.2 kB: they share the transport. What you do not import is not
shipped (`sideEffects: false`, one entry per feature). No runtime dependencies.

## Install

```sh
npm install @mirafive/sdk-server
# or: bun add / pnpm add / yarn add / deno add npm:@mirafive/sdk-server
```

Node ≥ 20, Bun, Deno, Cloudflare Workers (workerd), Vercel and Netlify edge functions.
It uses only `fetch`, `crypto.subtle`, `crypto.randomUUID`, `AbortController`, timers and
`TextEncoder`. ESM only.

## Quickstart

```ts
import { Mira } from "@mirafive/sdk-server"

const mira = new Mira({ key: process.env.MIRAFIVE_SECRET_KEY })

mira.track("signup", { userId: user.id, properties: { plan: "pro" } })
mira.identify(user.id, { plan: "pro" }, { anonymousId }) // anonymousId from the browser SDK, if you have it

await mira.flush() // before a short-lived process or function ends
```

`track()` and `identify()` buffer: a batch leaves at 100 events or after one second.
`send()` delivers at once and resolves to the server's receipt.

Verify it: send `$install_check`. It proves the key and host work and is never stored or
billed.

```ts
const receipt = await mira.send([{ name: "$install_check" }])
// { batch: "…", accepted: 0, dropped: 1, reason: "install_check" }
```

### Node, Bun, Deno

Create one client per process and reuse it. Its flush timer does not keep the process
alive, so flush before exiting:

```ts
process.on("SIGTERM", async () => {
  await mira.shutdown()
  process.exit(0)
})
```

In a script or CLI, `await mira.flush()` (or `shutdown()`) at the end. Deno needs
`--allow-net` for the host (and `--allow-env` to read the key from the environment).

### Cloudflare Workers

Keep one `Mira` and one `MiraFlags` per isolate, so the flag document is fetched once
and shared by every request. Hand each request's work to that request's
`ctx.waitUntil`: `flags.for(unit, { waitUntil })` for refreshes and exposures,
`ctx.waitUntil(mira.flush())` for your own events.

```ts
import { Mira } from "@mirafive/sdk-server"
import { bootstrapHeaders, MiraFlags } from "@mirafive/sdk-server/flags"

let mira: Mira | undefined
let flags: MiraFlags | undefined

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    mira ??= new Mira({ key: env.MIRAFIVE_SECRET_KEY })
    flags ??= new MiraFlags({ key: env.MIRAFIVE_SECRET_KEY, mira })

    const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise)
    const user = await flags.for({ userId: await sessionUser(request) }, { waitUntil })

    mira.track("api_call", { properties: { path: new URL(request.url).pathname } })
    ctx.waitUntil(mira.flush())

    return new Response(`<head>${user.bootstrap()}</head>…`, {
      headers: { "Content-Type": "text/html", ...bootstrapHeaders }
    })
  }
}
```

A client used by one request only can take `waitUntil` in its constructor instead:
`new Mira({ key, waitUntil: (p) => ctx.waitUntil(p) })`.

### Vercel functions

```ts
import { waitUntil } from "@vercel/functions"
import { Mira } from "@mirafive/sdk-server"

const mira = new Mira({ key: process.env.MIRAFIVE_SECRET_KEY, waitUntil })
```

### Next.js route handlers and server actions

Flush after the response with `after()`:

```ts
// app/api/checkout/route.ts
import { after } from "next/server"
import { Mira } from "@mirafive/sdk-server"

const mira = new Mira({ key: process.env.MIRAFIVE_SECRET_KEY })

export async function POST(request: Request): Promise<Response> {
  const order = await createOrder(request)

  mira.track("order completed", {
    userId: order.customerId,
    properties: { revenue: order.total, currency: "EUR" }
  })
  after(() => mira.flush())

  return Response.json(order)
}
```

`@mirafive/sdk-next/server` wraps exactly this as `mira()`.

### Serverless flushing, in short

A function that returns before its events are delivered loses them. Pick one:

- pass `waitUntil` (Workers `ctx.waitUntil`, `@vercel/functions`, Netlify `context.waitUntil`):
  every delivery, including the one the flush timer will start, is handed to it;
- or call `after(() => mira.flush())` in Next.js;
- or `await mira.flush()` before returning.

### Idempotent sends

Webhooks and jobs are delivered twice sometimes. Name the batch after what it is about and
a repeat is stored and billed once:

```ts
await mira.send(
  [{ name: "order completed", userId: order.customerId, properties: { revenue: 129, currency: "EUR" } }],
  { idempotencyKey: `order-${order.id}` }
)
```

The batch id is derived from the key (`UUIDv8(SHA-256("mirafive:batch:" + key))`, PROTOCOL
§5), so every MIRA FIVE SDK maps the same key to the same batch. The server deduplicates
for a day. Retries always resend the byte-identical body. To resend byte-identically from
another process (a durable outbox, sdk-convex), also fix each event's `time` and pass
`sentAt`: `send(events, { idempotencyKey, sentAt })`.

### Flags and SSR bootstrap

```ts
import { Mira } from "@mirafive/sdk-server"
import { bootstrapHeaders, MiraFlags } from "@mirafive/sdk-server/flags"

const mira = new Mira({ key: process.env.MIRAFIVE_SECRET_KEY })
const flags = new MiraFlags({ key: process.env.MIRAFIVE_SECRET_KEY, mira })

const user = await flags.for({ userId: session.userId, anonymousId, properties: { plan: "pro" } })

if (user.enabled("new-checkout")) {
  // …
}

const headline = user.variant("pricing-test", "control")
const limits = user.config("limits", { max: 3 })
```

The first read waits up to 1.5 s for the flag document; later reads are synchronous and
refresh it in the background every 30 seconds (ETag, `If-None-Match`). Experiments counted
on the server send one `$exposure` per unit, variant and hour through `mira`; with a
`waitUntil` (per call or in the constructor) it is flushed with that request. A flag the
SDK cannot read answers your fallback and is reported once to `onError`; reads never throw.

Hand the answers to the browser SDK so the first render matches:

```ts
const html = `<!doctype html><html><head>${user.bootstrap()}</head>…`

return new Response(html, { headers: { "Content-Type": "text/html", ...bootstrapHeaders } })
```

`bootstrap()` renders `<script type="application/json" id="mirafive-flags">…</script>`
with `<`, `>`, `&`, U+2028 and U+2029 escaped. It carries only flags the website reads
too, never server-only values. `bootstrapHeaders` is `Cache-Control: private, no-store`,
because the block is per visitor.

## Consent & privacy

- Default mode: `full`. Server events carry the identifiers you pass (`userId`,
  `anonymousId`, `sessionId`); you, the customer, hold the consent or other lawful basis
  for them. Use your own pseudonymous user id, never an email address.
- `mode: "consentless"` counts without identifiers (revenue, invoices, anonymous totals).
  Passing `userId`, `anonymousId` or `sessionId` then throws a `TypeError`: it is a
  programming error, and the server would refuse the whole batch.
- Flags: `flags.for({ consent: { experiments, targeting } })` takes the visitor's answer.
  Without `experiments` the anonymous id is not used and no one is counted in an
  experiment; without `targeting` no segment is looked up. Omitted scopes count as granted.
- Do Not Track and Global Privacy Control reach a server as `DNT: 1` / `Sec-GPC: 1`
  headers. Pass `flags.for({ …, optedOut: true })`: no ids, no segment lookup, no
  exposure and no unit in the bootstrap; fixed values and property rules still apply.
  For events, leave the ids out of `track()` or send consentless.
- Nothing is stored. Flag properties you pass are evaluated in memory and never sent.
- The secret key never reaches a browser: `new Mira()` throws where `window` and
  `document` exist.

## API reference

### `@mirafive/sdk-server`

`new Mira<Events>(options)`

| Option | Default | |
|---|---|---|
| `key` | — | the source's secret key, `process.env.MIRAFIVE_SECRET_KEY` |
| `host` | `https://events.mirafive.io` | `https://`; plain `http://` only for localhost, 127.0.0.1 and [::1]. An empty string means the default |
| `mode` | `"full"` | or `"consentless"` |
| `flushAt` | `100` | 1–1000 events per buffered batch |
| `flushAfterMs` | `1000` | how long an event waits in the buffer |
| `timeoutMs` | `10000` | per request |
| `maxRetries` | `3` | on 408, 429, 5xx, network errors and timeouts |
| `fetch` | global `fetch` | a custom transport |
| `waitUntil` | — | receives every in-flight delivery |
| `onError` | `console.warn` | failures of buffered events: transport errors, refused (`invalid_event`) events, and batches the server dropped for `ingestion_paused` or `allowance_exhausted` |

| Member | |
|---|---|
| `track(name, { userId?, anonymousId?, sessionId?, properties?, time?, page?, id? })` | buffer an event; `time` is a `Date`, epoch ms or an ISO string, default now; `id` a UUID of your own |
| `identify(userId, traits?, { anonymousId? })` | buffer `$identify` |
| `send(events, { idempotencyKey?, signal?, sentAt? }): Promise<Receipt>` | 1–1000 events as one batch, now; rejects with `MiraError`; honours `Retry-After` up to 120 s |
| `flush(): Promise<void>` | send the buffer and wait for every delivery; never rejects |
| `shutdown(): Promise<void>` | flush and stop; later events go to `onError` |
| `with({ userId?, anonymousId?, properties? }): Mira` | a view whose events carry these; shares the buffer |

`Receipt` is `{ batch, accepted, dropped, reason? }`; `dropped > 0` with a `reason`
(`bot`, `install_check`, `ingestion_paused`, `allowance_exhausted`) means nothing was kept.

`MiraError extends Error`: `code`, `status?`, `retryable`, `retryAfterMs?`, `errors?`.
Codes are the server's (`validation_failed`, `unauthorized`, `rate_limited`, …) plus
`network_error`, `timeout`, `aborted`, `invalid_event` (refused before sending) and
`unexpected` (an answer without a code).

Typed events are types only: `new Mira<{ signup: { plan: "free" | "pro" } }>(…)` narrows
the names and properties of `track()` and `send()`.

Types: `MiraOptions`, `EventOptions`, `SendEvent`, `SendOptions`, `Scope`, `Events`,
`Receipt`, `Mode`, `Page`, `Json`, `MiraErrorCode`, `Fetch`.

### `@mirafive/sdk-server/flags`

`new MiraFlags(options)`: `key`, `host?`, `refreshSeconds?` (30, at least 10),
`timeoutMs?` (how long the first read waits, 1500), `document?` (a snapshot used while it is
younger than 7 days), `mira?` (counts server-side exposures), `fetch?`, `waitUntil?`
(receives refreshes), `onError?`.

| Member | |
|---|---|
| `for(unit?, { waitUntil? }?): Promise<UserFlags>` | `unit`: `{ userId?, anonymousId?, properties?, consent?: { experiments?, targeting? }, optedOut? }`; `waitUntil` overrides the constructor's for this call |
| `ready(): Promise<boolean>` | whether a document is usable after waiting up to `timeoutMs` |
| `snapshot(): FlagDocument \| undefined` | the document in use, e.g. to store as a build-time snapshot |
| `status()` | `{ ready, stale, stopped, fetchedAt? }`; stale after 5 minutes without confirmation, stopped after a 401/403 |

`UserFlags`: `enabled(key, fallback = false)`, `variant(key, fallback?)`,
`config(key, fallback)`, `evaluate(key)` (explains, never counts), `bootstrap()`.

`evaluate()` returns `{ variant, reason, rule?, errorCode? }` or
`{ reason: "ERROR", errorCode }`. Reasons: `STATIC`, `TARGETING_MATCH`, `SPLIT`,
`DEFAULT`, `DISABLED`. Error codes: `NOT_READY` (no document yet), `FLAG_NOT_FOUND`,
`UNSUPPORTED` (a newer or broken flag format); on a variant, `MEMBERSHIP_UNAVAILABLE` (segments
could not be looked up, so their conditions were false) and `NOT_ALLOWED` (an experiment
counted in the browser, or no consent: the default is served).

`bootstrapHeaders`: `{ "Cache-Control": "private, no-store" }`.

## Framework / runtime notes

- Every event is checked and serialised when you call `track()`, against the server's
  limits (name ≤ 128 characters, ids ≤ 256, page URL/referrer ≤ 2048 and title ≤ 512,
  properties ≤ 64 values, ≤ 5 levels, keys ≤ 128 characters, ≤ 32 KB as the server
  encodes them). An event that fails, or whose properties are not JSON (a `BigInt`, a
  cycle), is dropped alone and reported as `invalid_event`; the rest of the batch goes.
- If the server still refuses a buffered batch (`400 validation_failed`), the events it
  names are dropped and the rest is sent once more under a batch id derived from the first.
- Buffered deliveries honour `Retry-After` up to 30 s, `send()` up to 120 s.

- Segment lookups (`POST /v1/flags/segments`) batch every `for()` of one tick, up to 100
  units per request, wait at most 300 ms and are cached for a minute.
- A failed refresh keeps the last document and backs off up to 5 minutes; a 401 or 403
  stops refreshing until restart.
- On Workers, keep `MiraFlags` per isolate and pass `for(unit, { waitUntil })` (see
  Quickstart). A `document` snapshot answers at once, before the first fetch.
- A missing key or a 401/403 stops refreshing until restart and reaches `onError`.
- Framework packages build on this one: `@mirafive/sdk-next/server`,
  `@mirafive/sdk-tanstack/start`, the Nuxt and Astro server utilities.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Nothing arrives | The function ended before delivery: pass `waitUntil`, use `after()` or `await mira.flush()`. Check `onError` and the host. |
| `403 secret_key_exposed` | The key was sent with an `Origin` or `Sec-Fetch-Site` header, i.e. from a browser. Rotate it and keep it server-side. |
| `403 website_key_as_bearer` | You passed the website key; server sources need the secret key. |
| `400 collection_mode_not_allowed` | The source is consentless and you send `mode: "full"`. |
| `TypeError: consentless mode …` | Identifiers in consentless mode; remove them or switch the mode. |
| `invalid_event` in `onError` | The event breaks a server limit (see runtime notes) or its properties are not JSON; it was dropped before sending, the others were sent. |
| `ingestion_paused` / `allowance_exhausted` in `onError` | The server accepted the batch but kept nothing: the organization is paused or out of allowance. |
| `collection_mode_not_allowed` from flags | `MiraFlags` got a consentless `Mira`, which cannot send exposures; pass a full-mode client. |
| A flag always returns its fallback | `evaluate(key)` tells why: `NOT_READY` (no document within 1.5 s), `FLAG_NOT_FOUND` (not in this source's flags), `NOT_ALLOWED` (consent, or an experiment counted in the browser). |

## For AI agents

Copy-paste setup prompt:

```text
Add MIRA FIVE server-side analytics (and flags, if the project uses feature flags) with @mirafive/sdk-server.
1. Install @mirafive/sdk-server with the project's package manager.
2. Read the secret key from the env var MIRAFIVE_SECRET_KEY (add MIRAFIVE_SECRET_KEY= to .env.example).
   It is server-only: never import this package or the key into client components or a browser bundle.
3. Create one client in a server-only module: `export const mira = new Mira({ key: process.env.MIRAFIVE_SECRET_KEY })`
   (on Cloudflare Workers: one per isolate from `env`, then `ctx.waitUntil(mira.flush())` per request).
4. Track the few business events that matter where they happen on the server, e.g.
   `mira.track("signup", { userId: user.id, properties: { plan } })`, and
   `mira.identify(user.id, { plan })` after signup/login. Use the internal user id, never an email.
   For webhooks, use `await mira.send([...], { idempotencyKey: event.id })`.
   Feature flags: `export const flags = new MiraFlags({ key: process.env.MIRAFIVE_SECRET_KEY, mira })`
   (import from "@mirafive/sdk-server/flags"), then `(await flags.for({ userId: user.id })).enabled("key")`.
5. Make sure events leave before the function ends: pass `waitUntil` (Vercel: from @vercel/functions),
   or `after(() => mira.flush())` in Next.js, or `await mira.flush()`; call `await mira.shutdown()` on SIGTERM.
6. Server events are "full" mode by default: the app holds consent. For anonymous counts only, use
   `mode: "consentless"` and pass no userId/anonymousId/sessionId.
7. Verify: run `await mira.send([{ name: "$install_check" }])` once and check the receipt's
   reason is "install_check". Report what you changed.
Do not add other analytics libraries, cookies or consent banners.
```

Facts for agents:

- Imports: `import { Mira, MiraError } from "@mirafive/sdk-server"`,
  `import { MiraFlags, bootstrapHeaders } from "@mirafive/sdk-server/flags"`.
- Env vars: `MIRAFIVE_SECRET_KEY` (server only, required), `MIRAFIVE_HOST` (optional,
  default `https://events.mirafive.io`). The package does not read env vars itself: pass
  `key: process.env.MIRAFIVE_SECRET_KEY` (`env.MIRAFIVE_SECRET_KEY` on Workers).
- Never ship `MIRAFIVE_SECRET_KEY` or this package to a browser bundle; a secret key
  seen from a browser is refused and marked exposed. Browsers use `@mirafive/sdk-browser`
  with `MIRAFIVE_WEBSITE_KEY`.
- On serverless and edge runtimes always pass `waitUntil`, use `after(() => mira.flush())`
  or `await mira.flush()`; otherwise buffered events are lost when the function ends.
- `track()`/`identify()` never throw for transport reasons; failures go to `onError`.
  `send()` rejects with `MiraError`. Identifiers in consentless mode throw `TypeError`.
- Event names starting with `$` are reserved; use plain names like `order completed`.
  Revenue goes in `properties: { revenue: 49.9, currency: "EUR" }`.
- Verify an install with `await mira.send([{ name: "$install_check" }])`: the receipt has
  `reason: "install_check"`; it is never stored or billed.
- Flags: `const flags = new MiraFlags({ key: process.env.MIRAFIVE_SECRET_KEY, mira })` once,
  then `const user = await flags.for({ userId }, { waitUntil })` (`optedOut: true` when the
  request has `Sec-GPC: 1` or `DNT: 1`), then `user.enabled(key)`,
  `user.variant(key, fallback)`, `user.config(key, fallback)`; in SSR put
  `user.bootstrap()` in `<head>` and send `bootstrapHeaders`.
- Wire contract: [mirafive/protocol](https://github.com/mirafive/protocol).

## License

[MIT](LICENSE) © 2026 Cloo GmbH
