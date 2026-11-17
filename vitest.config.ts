import { defineConfig } from 'vitest/config'

// Source tests use a deterministic deployment; production builds read the SDK .env.
export default defineConfig({
  define: { __TRON_SESSION_ESCROW_ADDRESS__: JSON.stringify(`0x${'66'.repeat(20)}`) },
})
