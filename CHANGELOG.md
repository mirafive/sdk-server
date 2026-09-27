# Changelog

## 0.5.0 — unreleased

Rebuilt from scratch on the v1 ingest protocol and the v1 flag spec.

- `Mira`: buffered `track()` and `identify()` (100 events or 1 s, timers never keep a
  process alive), `send()` with idempotency keys (batch id per PROTOCOL §5), `flush()`,
  `shutdown()`, `with()` views sharing one buffer, typed events (types only).
- Batches split at 1000 events and 1 MiB. Retries on 408, 429, 5xx, network errors and
  timeouts with full-jitter backoff (250 ms · 2ⁿ, at most 4 s) and `Retry-After` held to
  250 ms–30 s, resending the byte-identical body.
- `waitUntil` receives every in-flight delivery; `onError` receives transport errors of
  buffered events; `send()` rejects with `MiraError`.
- Consentless mode refuses identifiers with a `TypeError`. Each event is validated against
  the server's limits and serialised on `track()`; an invalid or unserialisable event is
  dropped alone (`invalid_event`), and a `400 validation_failed` buffered batch is resent
  once without the events it names. `flush()` never rejects. Batches dropped for
  `ingestion_paused` or `allowance_exhausted` reach `onError`. `send()` takes `sentAt` and
  honours `Retry-After` up to 120 s. Plain `http://` only for localhost. Refuses to run in
  a browser.
- `@mirafive/sdk-server/flags`: `MiraFlags` with ETag refresh on read (30 s, ±10 %
  jitter, backoff to 5 minutes, stop on 401/403), a 7-day `document` snapshot, batched
  segment lookups (100 units, 300 ms, one-minute cache), server-counted exposures
  deduplicated per unit, variant and hour, and an escaped SSR `bootstrap()` block with
  `bootstrapHeaders`. `for(unit, { waitUntil })` lets one instance serve every request of a
  Workers isolate; `optedOut` for DNT/GPC; a flag the SDK cannot read answers the fallback
  and is reported to `onError`.
- The flag evaluator and batch ids pass the shared MIRA FIVE fixtures. Smoke-tested on
  Node, Bun, Deno and workerd.
