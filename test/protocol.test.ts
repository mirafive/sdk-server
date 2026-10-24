import { describe, expect, it } from "vitest"

import { batchIdFor } from "../src/protocol/batch-id.ts"
import { fixture, sha256 } from "./helpers.ts"

// Copied unchanged from mirafive/protocol; a changed file must come from there.
const pinned: Record<string, string> = {
  "batch.schema.json": "5026f7f0325647b19b91497e64ca4370efa614920f6c51271587bffc426ba330",
  "batch-id.cases.json": "aa311a62830cb60bac8884d80f125bb21454e82fdc0a41582540d3eff8431dd0"
}

it.each(Object.entries(pinned))("%s is the pinned copy", (name, hash) => {
  expect(sha256(fixture(name))).toBe(hash)
})

describe("batch ids", () => {
  const { cases } = JSON.parse(fixture("batch-id.cases.json")) as { cases: { key: string; batch: string }[] }

  it.each(cases)("derives $batch", async ({ key, batch }) => {
    expect(await batchIdFor(key)).toBe(batch)
  })
})
