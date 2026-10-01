import { defineConfig, mergeConfig } from 'vite'
import baseConfig from './vite.config.js'
import { localDemo } from './scripts/local-demo.mjs'

export default defineConfig((environment) => {
  if (environment.command !== 'serve') throw new Error('Demo mode is local-only and cannot be published.')
  return mergeConfig(baseConfig(environment), {
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify('') },
    plugins: [localDemo()],
  })
})
