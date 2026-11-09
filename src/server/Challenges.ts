import { Challenge, Errors, type Store } from 'mppx'
import { Transport } from 'mppx/server'
import { InvalidRequestError, SessionError } from '../protocol/Errors.js'

/** Persist the exact issued auth-params before exposing an HTTP challenge. */
export function challengeTransport(store: Store.AtomicStore): Transport.Http {
  const http = Transport.http()
  return {
    ...http,
    async respondChallenge(options) {
      await store.put(`tron:issued:${options.challenge.id}`, Challenge.serialize(options.challenge))
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
export async function assertIssuedChallenge(store: Store.AtomicStore, challenge: Challenge.Challenge): Promise<void> {
  const stored = await store.get(`tron:issued:${challenge.id}`)
  if (stored !== Challenge.serialize(challenge)) throw new Errors.InvalidChallengeError({ id: challenge.id, reason: 'Challenge was not issued by this server or its auth-params differ' })
  if (challenge.expires && Date.parse(challenge.expires) <= Date.now()) throw new Errors.InvalidChallengeError({ id: challenge.id, reason: 'Challenge expired' })
}
