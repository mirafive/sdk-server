// Vendored from mirafive/protocol 5037788489cb. Do not edit; run bun run vendor:protocol.
export const batchIdFor = async (key: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`mirafive:batch:${key}`))
  const hex = Array.from(new Uint8Array(digest, 0, 16), (byte, index) =>
    (index === 6 ? (byte & 0x0f) | 0x80 : index === 8 ? (byte & 0x3f) | 0x80 : byte)
      .toString(16)
      .padStart(2, "0")
  ).join("")

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
