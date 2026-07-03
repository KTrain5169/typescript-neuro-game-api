import { defineConfig } from "tsdown";

const tsconfig = './tsconfig.json'

export default defineConfig({
  entry: 'src/index.ts',
  outDir: 'dist',
  format: ['esm', 'cjs'],
  tsconfig,
  attw: true,
  publint: true,
})
