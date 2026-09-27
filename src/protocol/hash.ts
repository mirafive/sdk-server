// Vendored from mirafive/protocol 5037788489cb. Do not edit; run bun run vendor:protocol.
const encoder = new TextEncoder()

export const SHARE_SALT = ".r"
export const VARIANT_SALT = ".v"
export const BUCKETS = 10_000

export const fnv1a32 = (input: string): number => {
  let hash = 0x811c9dc5

  for (const byte of encoder.encode(input)) {
    hash = Math.imul(hash ^ byte, 0x01000193)
  }

  return hash >>> 0
}

export const bucket = (seed: string, salt: string, unit: string): number =>
  fnv1a32(String(fnv1a32(seed + salt + unit))) % BUCKETS
