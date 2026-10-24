# @mirafive/sdk-server

Send events from your server — Node, Bun, Deno, Cloudflare Workers, Vercel and other
edge runtimes. Privacy-first analytics from MIRA FIVE, hosted in the EU.

## Size

`@mirafive/sdk-server` is 3.48 kB (min + gzip). What you do not import is not shipped
(`sideEffects: false`). No runtime dependencies.

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

Keep one `Mira` per isolate, shared by every request. Hand each request's events to that
request's `ctx.waitUntil(mira.flush())`.

```ts
import { Mira } from "@mirafive/sdk-server"

let mira: Mira | undefined

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    mira ??= new Mira({ key: env.MIRAFIVE_SECRET_KEY })

    mira.track("api_call", { properties: { path: new URL(request.url).pathname } })
    ctx.waitUntil(mira.flush())

    return new Response("ok")
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

## Consent & privacy

- Default mode: `full`. Server events carry the identifiers you pass (`userId`,
  `anonymousId`, `sessionId`); you, the customer, hold the consent or other lawful basis
  for them. Use your own pseudonymous user id, never an email address.
- `mode: "consentless"` counts without identifiers (revenue, invoices, anonymous totals).
  Passing `userId`, `anonymousId` or `sessionId` then throws a `TypeError`: it is a
  programming error, and the server would refuse the whole batch.
- Nothing is stored.
- The secret key never reaches a browser: `new Mira()` throws where `window` and
  `document` exist.

## API reference

### `@mirafive/sdk-server`

`new Mira<Events>(options)`

| Option | Default | |
|---|---|---|
| `key` | — | the source's secret key, `process.env.MIRAFIVE_SECRET_KEY` |
| `host` | `https://collect.mirafive.io` | `https://`; plain `http://` only for localhost, 127.0.0.1 and [::1]. An empty string means the default |
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

## Framework / runtime notes

- Every event is checked and serialised when you call `track()`, against the server's
  limits (name ≤ 128 characters, ids ≤ 256, page URL/referrer ≤ 2048 and title ≤ 512,
  properties ≤ 64 values, ≤ 5 levels, keys ≤ 128 characters, ≤ 32 KB as the server
  encodes them). An event that fails, or whose properties are not JSON (a `BigInt`, a
  cycle), is dropped alone and reported as `invalid_event`; the rest of the batch goes.
- If the server still refuses a buffered batch (`400 validation_failed`), the events it
  names are dropped and the rest is sent once more under a batch id derived from the first.
- Buffered deliveries honour `Retry-After` up to 30 s, `send()` up to 120 s.

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

## For AI agents

Copy-paste setup prompt:

```text
Add MIRA FIVE server-side analytics with @mirafive/sdk-server.
1. Install @mirafive/sdk-server with the project's package manager.
2. Read the secret key from the env var MIRAFIVE_SECRET_KEY (add MIRAFIVE_SECRET_KEY= to .env.example).
   It is server-only: never import this package or the key into client components or a browser bundle.
3. Create one client in a server-only module: `export const mira = new Mira({ key: process.env.MIRAFIVE_SECRET_KEY })`
   (on Cloudflare Workers: one per isolate from `env`, then `ctx.waitUntil(mira.flush())` per request).
4. Track the few business events that matter where they happen on the server, e.g.
   `mira.track("signup", { userId: user.id, properties: { plan } })`, and
   `mira.identify(user.id, { plan })` after signup/login. Use the internal user id, never an email.
   For webhooks, use `await mira.send([...], { idempotencyKey: event.id })`.
5. Make sure events leave before the function ends: pass `waitUntil` (Vercel: from @vercel/functions),
   or `after(() => mira.flush())` in Next.js, or `await mira.flush()`; call `await mira.shutdown()` on SIGTERM.
6. Server events are "full" mode by default: the app holds consent. For anonymous counts only, use
   `mode: "consentless"` and pass no userId/anonymousId/sessionId.
7. Verify: run `await mira.send([{ name: "$install_check" }])` once and check the receipt's
   reason is "install_check". Report what you changed.
Do not add other analytics libraries, cookies or consent banners.
```

Facts for agents:

- Imports: `import { Mira, MiraError } from "@mirafive/sdk-server"`.
- Env vars: `MIRAFIVE_SECRET_KEY` (server only, required), `MIRAFIVE_HOST` (optional,
  default `https://collect.mirafive.io`). The package does not read env vars itself: pass
  `key: process.env.MIRAFIVE_SECRET_KEY` (`env.MIRAFIVE_SECRET_KEY` on Workers).
- Never ship `MIRAFIVE_SECRET_KEY` or this package to a browser bundle; a secret key
  seen from a browser is refused and marked exposed. Browsers use `@mirafive/sdk-browser`
  with `MIRAFIVE_WEBSITE_KEY`.
- On serverless and edge runtimes always pass `waitUntil`, use `after(() => mira.flush())`
  or `await mira.flush()`; otherwise buffered events are lost when the function ends.
- `track()`/`identify()` never throw for transport reasons; failures go to `onError`.
  `send()` rejects with `MiraError`. Identifiers in consentless mode throw `TypeError`.
- Event names starting with `$` are reserved; use plain names like `order completed`.
  Revenue goes in `properties: { revenue: 49.9, currency: "EUR" }`. Add `payment_id`
  (1–255 characters) with the payment provider's id of the payment. For Stripe pass the
  PaymentIntent id (`pi_…`) from your webhook, for example
  `properties: { revenue: 49.9, currency: "EUR", payment_id: paymentIntent.id }`.
  MIRA FIVE merges the event with the payment it imports from your connected Stripe
  account, so the sale counts once.
- Verify an install with `await mira.send([{ name: "$install_check" }])`: the receipt has
  `reason: "install_check"`; it is never stored or billed.
- Wire contract: [mirafive/protocol](https://github.com/mirafive/protocol).

## License

[MIT](LICENSE) © 2026 Cloo GmbH
