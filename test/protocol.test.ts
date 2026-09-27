import { describe, expect, it } from "vitest"

import { batchIdFor } from "../src/protocol/batch-id.ts"
import { evaluate } from "../src/protocol/evaluate.ts"
import type { Facts, Flag } from "../src/protocol/types.ts"
import { fixture, sha256 } from "./helpers.ts"

// Copied unchanged from mirafive/protocol; a changed file must come from there.
const pinned: Record<string, string> = {
  "batch.schema.json": "94ef27603d6d79ae8c370599445743c699e8c04d322198734b05268782c6a192",
  "batch-id.cases.json": "aa311a62830cb60bac8884d80f125bb21454e82fdc0a41582540d3eff8431dd0",
  "flag-eval.cases.json": "a4cd7b9a38311a08d63b8c5953c0b7a808210f9bf5960a71642978e71235c6f6"
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

describe("flag evaluation", () => {
  const { cases } = JSON.parse(fixture("flag-eval.cases.json")) as {
    cases: { name: string; flag: Flag; facts: Facts; expect: unknown }[]
  }

  it.each(cases)("$name", ({ flag, facts, expect: expected }) => {
    expect(evaluate(flag, facts)).toEqual(expected)
  })
})
