import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import { Ajv2020 } from "ajv/dist/2020.js"
import { expect } from "vitest"

export const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex")

const schema = new Ajv2020({ strict: true, allErrors: true }).compile(
  JSON.parse(fixture("batch.schema.json")) as object
)

export interface Batch {
  v: number
  batch: string
  mode: string
  sentAt: number
  context: { sdk: string }
  events: Record<string, unknown>[]
}

export interface Call {
  url: string
  method: string
  headers: Record<string, string>
  raw: string | undefined
  body: unknown
  signal: AbortSignal | undefined
}

/** Every batch this SDK emits must match mirafive/protocol's schema. */
export const assertBatch = (body: unknown): Batch => {
  expect(schema(body), JSON.stringify(schema.errors)).toBe(true)

  return body as Batch
}

type Respond = (call: Call, index: number) => Response | Error | Promise<Response | Error>

export const fakeFetch = (respond: Respond = accept) => {
  const calls: Call[] = []
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const raw = typeof init.body === "string" ? init.body : undefined
    const call: Call = {
      url,
      method: init.method ?? "GET",
      headers: (init.headers ?? {}) as Record<string, string>,
      raw,
      body: raw === undefined ? undefined : JSON.parse(raw),
      signal: init.signal ?? undefined
    }

    calls.push(call)

    if (url.endsWith("/v1/batch")) {
      assertBatch(call.body)
    }

    const answer = await respond(call, calls.length - 1)

    if (answer instanceof Error) {
      throw answer
    }

    return answer
  }

  return { fetch, calls, batches: () => calls.map((call) => call.body as Batch) }
}

export const json = (status: number, body?: unknown, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers })

export function accept(call: Call): Response {
  const batch = call.body as Batch

  return json(202, { batch: batch.batch, accepted: batch.events.length, dropped: 0 })
}

/** Answers only when the request's signal aborts, as a hung server would. */
export const hang = (call: Call): Promise<Error> =>
  new Promise((resolve) => {
    call.signal?.addEventListener("abort", () => {
      resolve(new DOMException("aborted", "AbortError"))
    })
  })
