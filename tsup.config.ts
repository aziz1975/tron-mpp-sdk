import { defineConfig } from 'tsup'
import { readBuildEscrowAddress } from './scripts/escrow-config.js'

export default defineConfig(() => ({
  entry: ['src/index.ts', 'src/config.ts', 'src/session.ts', 'src/client/index.ts', 'src/server/index.ts', 'src/tronweb/index.ts'],
  format: ['esm'],
  sourcemap: true,
  clean: true,
  define: {
    __TRON_SESSION_ESCROW_ADDRESS__: JSON.stringify(readBuildEscrowAddress(new URL('.env', import.meta.url))),
  },
}))
