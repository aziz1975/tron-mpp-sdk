import { defineConfig } from 'tsup'
import { readBuildEscrowAddresses } from './scripts/escrow-config.js'

export default defineConfig(() => ({
  entry: ['src/index.ts', 'src/config.ts', 'src/session.ts', 'src/client/index.ts', 'src/server/index.ts', 'src/tronweb/index.ts'],
  format: ['esm'],
  sourcemap: true,
  clean: true,
  define: {
    __TRON_SESSION_ESCROW_ADDRESSES__: JSON.stringify(readBuildEscrowAddresses(new URL('.env', import.meta.url))),
  },
}))
