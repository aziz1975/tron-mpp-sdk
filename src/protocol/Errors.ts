import { Errors } from 'mppx'
import type { Hex } from 'viem'

/** The node definitively rejected a read-only contract simulation. No transaction was sent. */
export class ContractCallRevertedError extends Error {
  constructor(readonly data: Hex = '0x') { super('Contract simulation reverted.') }
}

export class InvalidRequestError extends Errors.PaymentError {
  readonly type = 'https://paymentauth.org/problems/invalid-request'
  readonly title = 'Invalid Request'
  override readonly status = 400
  constructor(message: string, cause?: unknown) { super(message, { cause }) }
}

/** No transaction was sent. A retry cannot duplicate this attempted submission. */
export class TransactionNotSubmittedError extends Errors.PaymentError {
  readonly type = 'https://paymentauth.org/problems/transaction-not-submitted'
  readonly title = 'Transaction Not Submitted'
  override readonly status = 503
  constructor(cause?: unknown) { super('Transaction was not submitted.', { cause }) }
}

/** Submission may have succeeded. Reconcile the known hash instead of paying again. */
export class TransactionOutcomeUnknownError extends Errors.PaymentError {
  readonly type = 'https://paymentauth.org/problems/transaction-outcome-unknown'
  readonly title = 'Transaction Outcome Unknown'
  override readonly status = 503
  constructor(readonly hash?: Hex, cause?: unknown) {
    super('Transaction outcome is unknown; reconciliation is required.', {
      cause, ...(hash ? { details: { hash } } : {}),
    })
  }
}

export function parseInput<T>(schema: { parse: (input: unknown) => T }, input: unknown, label: string): T {
  try { return schema.parse(input) }
  catch (error) {
    if (error instanceof Errors.PaymentError) throw error
    throw new InvalidRequestError(`Invalid ${label}.`, error)
  }
}

export async function paymentBoundary<T>(action: () => Promise<T>): Promise<T> {
  try { return await action() }
  catch (error) {
    if (error instanceof Errors.PaymentError) throw error
    throw new Errors.InternalPaymentError({ cause: error })
  }
}

export class TransactionRevertedError extends Errors.PaymentError {
  readonly code = 'transaction-reverted'
  readonly title = 'Transaction Reverted'
  readonly type = 'https://paymentauth.org/problems/transaction-reverted'
  override readonly status = 409
  constructor(readonly hash?: Hex) { super('TRON transaction reverted.', hash ? { details: { hash } } : undefined) }
}

export class SessionError extends Errors.PaymentError {
  readonly type: string
  readonly title: string
  constructor(readonly code: string, override readonly status: number, detail: string) {
    super(detail)
    this.type = `https://paymentauth.org/problems/session/${code}`
    this.title = code.split('-').map(word => word[0]!.toUpperCase() + word.slice(1)).join(' ')
  }
  response(): Response {
    return Response.json(this.toProblemDetails(), {
      status: this.status, headers: { 'Content-Type': 'application/problem+json' },
    })
  }
}

/** A session contract simulation failed before submission. Safe to release its reservation. */
export class SessionSimulationError extends SessionError {}
