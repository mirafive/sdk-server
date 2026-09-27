import { defineConfig } from "tsdown"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    flags: "src/flags.ts"
  },
  format: "esm",
  platform: "neutral",
  target: "es2022",
  dts: true,
  sourcemap: false,
  clean: true,
  hash: false,
  fixedExtension: false,
  outputOptions: { chunkFileNames: "shared.js" }
})
