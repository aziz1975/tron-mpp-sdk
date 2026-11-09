import { Challenge, Errors, z, type Store } from 'mppx'
import { Transport } from 'mppx/server'
import { keccak256, toBytes } from 'viem'
import { InvalidRequestError, SessionError } from '../protocol/Errors.js'

const BucketSchema = z.object({
  version: z.literal(2),
  entries: z.record(z.string(), z.object({ serialized: z.string(), expires: z.number() })),
})
const defaultLimit = 64
function location(id: string) {
  const digest = keccak256(toBytes(id))
  return { key: `tron:issued:v2:${digest.slice(2, 4)}`, digest }
}
function activeEntries(value: unknown, now: number) {
  if (value === null) return {}
  const parsed = BucketSchema.safeParse(value)
  if (!parsed.success) throw new Errors.InternalPaymentError({ cause: parsed.error })
  return Object.fromEntries(Object.entries(parsed.data.entries).filter(([, entry]) => entry.expires > now))
}
async function remember(store: Store.AtomicStore, challenge: Challenge.Challenge, limit: number): Promise<boolean> {
  const { key, digest } = location(challenge.id)
  const expires = Date.parse(challenge.expires ?? '')
  const serialized = Challenge.serialize(challenge)
  return store.update(key, value => {
    const entries = activeEntries(value, Date.now())
    if (expires <= Date.now()) return { op: 'noop', result: false }
    if (!entries[digest] && Object.keys(entries).length >= limit) return { op: 'set', value: { version: 2, entries }, result: false }
    entries[digest] = { serialized, expires }
    return { op: 'set', value: { version: 2, entries }, result: true }
  })
}

/** Persist the exact issued auth-params before exposing an HTTP challenge. */
export function challengeTransport(store: Store.AtomicStore, limit = defaultLimit): Transport.Http {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('maxIssuedChallengesPerBucket must be a positive safe integer.')
  const http = Transport.http()
  return {
    ...http,
    async respondChallenge(options) {
      const expires = Date.parse(options.challenge.expires ?? '')
      if (!Number.isFinite(expires) || expires <= Date.now()) return Response.json({ error: 'A finite future challenge expiry is required.' }, { status: 500 })
      if (!await remember(store, options.challenge, limit)) return Response.json({ error: 'Challenge capacity reached; retry later.' }, { status: 503 })
      let error = options.error
      if (options.challenge.intent === 'charge') {
        if (error instanceof Errors.InvalidPayloadError) error = new Errors.MalformedCredentialError({ reason: 'Malformed payment credential' })
        if (error instanceof Errors.VerificationFailedError && error.status !== 402) error = new Errors.VerificationFailedError({ reason: error.message })
      } else if (error instanceof Errors.InvalidPayloadError || error instanceof Errors.MalformedCredentialError) error = new InvalidRequestError('Malformed payment credential.', error)
      if (error instanceof Errors.InvalidChallengeError && options.challenge.intent === 'session') error = new SessionError('challenge-not-found', 402, 'Challenge unknown or expired.')
      return http.respondChallenge({ ...options, error })
    },
  }
}
export async function assertIssuedChallenge(store: Store.AtomicStore, challenge: Challenge.Challenge, limit = defaultLimit): Promise<void> {
  const { key, digest } = location(challenge.id)
  const serialized = Challenge.serialize(challenge)
  const found = await store.update(key, value => {
    const entries = activeEntries(value, Date.now())
    return { op: Object.keys(entries).length ? 'set' : 'delete', value: { version: 2, entries }, result: entries[digest]?.serialized === serialized }
  })
  if (found) return
  // Preserve still-valid challenges issued before the bounded registry upgrade.
  const legacyKey = `tron:issued:${challenge.id}`
  const legacy = await store.get(legacyKey)
  if (legacy === serialized) {
    const expires = Date.parse(challenge.expires ?? '')
    if (Number.isFinite(expires) && expires > Date.now()) {
      if (await remember(store, challenge, limit)) await store.delete(legacyKey)
      return
    }
    await store.delete(legacyKey)
  }
  throw new Errors.InvalidChallengeError({ id: challenge.id, reason: 'Challenge unknown, expired, or auth-params differ' })
}
