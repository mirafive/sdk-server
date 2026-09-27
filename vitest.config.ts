import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"]
    // Browser SDKs: `environment: "happy-dom"` (bun add -d happy-dom), or `// @vitest-environment happy-dom` per file.
  }
})
