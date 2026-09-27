import { readFileSync, writeFileSync } from "node:fs"

import { afterEach, expect, it, vi } from "vitest"

import { Mira } from "../src/index.ts"
import { assertBatch, fakeFetch } from "./helpers.ts"

// The batch the Laravel app's contract test ingests (tests/Fixtures/sdk/sdk-server.json).
// Regenerate with `bun run golden` after a wire change, then copy it over.
const golden = new URL("golden/server.json", import.meta.url)

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it("emits the golden server batch", async () => {
  const now = 1_790_153_842_822

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now })
  vi.spyOn(crypto, "randomUUID").mockReturnValue("0192d4a8-7b1c-4e8a-9c1d-2b3e4f5a6b7c")

  const { fetch, calls } = fakeFetch()
  const mira = new Mira({ key: "mf_ab12cd34_secret", fetch })

  mira.identify(
    "user_8412",
    { plan: "pro", company: "Analytical Engines Ltd" },
    { anonymousId: "01a0cd7b-e071-7834-80bd-c70f7c603371" }
  )
  mira.track("subscription_renewed", {
    userId: "user_8412",
    properties: { revenue: 480, currency: "EUR", interval: "year" }
  })
  mira.track("invoice_sent", {
    id: "01a0cd7b-e085-7aea-8044-494ef4e695b4",
    userId: "user_8412",
    time: now - 60_001,
    properties: { invoice: "INV-2026-0042" }
  })
  await mira.flush()

  const batch = assertBatch(JSON.parse(calls[0]?.raw ?? ""))
  const text = `${JSON.stringify(batch, null, 4)}\n`

  if (process.env["MIRAFIVE_WRITE_GOLDEN"]) {
    writeFileSync(golden, text)
  }

  expect(text).toBe(readFileSync(golden, "utf8"))
})
