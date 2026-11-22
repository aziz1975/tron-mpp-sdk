import { defineConfig } from 'vitest/config'

// Source tests use deterministic deployments; production builds read the SDK .env.
export default defineConfig({
  define: {
    __TRON_SESSION_ESCROW_ADDRESSES__: JSON.stringify({
      3448148188: `0x${'66'.repeat(20)}`,
      728126428: `0x${'77'.repeat(20)}`,
    }),
  },
})
