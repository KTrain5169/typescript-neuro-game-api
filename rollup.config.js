import typescript from '@rollup/plugin-typescript'
import resolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'

const tsconfig = './tsconfig.json'

export default [
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/index.cjs.js',
        format: 'cjs',
        sourcemap: true,
        exports: 'named',
      },
      {
        file: 'dist/index.esm.js',
        format: 'esm',
        sourcemap: true,
      },
    ],
    plugins: [
      typescript({
        tsconfig,
        exclude: ['examples/**/*']
      }),
      resolve({
        preferBuiltins: true,
      }),
      commonjs(),
    ],
    external: ['ws', 'json-schema', 'http'], // Mark dependencies as external
  },
]
