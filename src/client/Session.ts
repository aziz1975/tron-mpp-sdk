import { Credential, Method } from 'mppx'
import type { Hex } from 'viem'
import * as S from '../protocol/Session.js'
import * as P from '../protocol/Primitives.js'

export type SessionParameters = {
  chainIds: readonly number[]
  currencies: readonly string[]
  escrowContracts: readonly string[]
  /** Trusted session payees. */
  recipients: readonly string[]
  maxUnitAmount: string
  maxCumulativeAmount: string
  payer: string
  wallet: S.Wallet
  /** Return unsigned instructions only. The SDK checks limits before wallet execution. */
  preparePayment: (challenge: { id: string; realm: string; request: S.Request; channel?: S.Channel | undefined }) => Promise<S.PaymentPlan>
}
export function session(parameters: SessionParameters) {
  if (!parameters.wallet || typeof parameters.preparePayment !== 'function') throw new TypeError('Session client requires a wallet and preparePayment.')
  const currencies = parameters.currencies.map(currency => P.TokenAddressSchema.parse(currency))
  const recipients = parameters.recipients.map(P.normalizeAddress)
  if (!recipients.length) throw new Error('Configure at least one trusted session recipient.')
  P.Uint128Schema.parse(parameters.maxCumulativeAmount)
  return Method.toClient(S.method, {
    async createCredential({ challenge }) {
      const request = S.RequestSchema.parse(challenge.request)
      if (!recipients.some(recipient => P.isSameAddress(recipient, request.recipient))) throw new Error('Session recipient is not allowed.')
      if (!parameters.chainIds.includes(request.methodDetails.chainId) ||
          !currencies.some(c => P.isSameAddress(c, request.currency)) ||
          !parameters.escrowContracts.some(c => P.isSameAddress(c, request.methodDetails.escrowContract))) throw new Error('Session chain, token or escrow is not allowed.')
      if (BigInt(request.amount) > BigInt(P.Uint128Schema.parse(parameters.maxUnitAmount))) throw new Error('Session unit price exceeds policy.')
      const policy: S.ClientPolicy = { maxCumulativeAmount: parameters.maxCumulativeAmount, expires: challenge.expires }
      S.assertClientPolicy(undefined, policy)
      const { wallet } = parameters
      if (wallet.payer && !P.isSameAddress(wallet.payer, parameters.payer)) throw new Error('Session wallet payer mismatch.')
      if (wallet.adapter.chainId !== request.methodDetails.chainId || !P.isSameAddress(wallet.adapter.escrowContract, request.methodDetails.escrowContract)) throw new Error('Session wallet network or escrow mismatch.')
      const readChannel = async (id: Hex, allowPendingClose: boolean, requirePayer = true) => {
        const channel = await wallet.adapter.channel(id)
        if (!channel || channel.finalized || (!allowPendingClose && channel.closeRequestedAt !== '0')) throw new Error('Session channel unavailable.')
        if ((requirePayer && !P.isSameAddress(channel.payer, parameters.payer)) || !P.isSameAddress(channel.payee, request.recipient) || !P.isSameAddress(channel.token, request.currency)) throw new Error('Session channel participants or token mismatch.')
        P.Uint128Schema.parse(channel.deposit)
        P.Uint128Schema.parse(channel.settled)
        if (BigInt(channel.settled) > BigInt(channel.deposit)) throw new Error('Invalid channel balance.')
        return channel
      }
      const resume = request.methodDetails.channelId
      const channel = resume ? await readChannel(resume, true, false) : undefined
      const plan = S.PaymentPlanSchema.parse(await parameters.preparePayment({ ...challenge, request: structuredClone(request), channel: channel ? { ...channel } : undefined }))
      S.assertClientPolicy(plan, policy)
      if ('type' in plan && !(request.methodDetails.credentialTypes ?? ['hash']).includes(plan.type)) throw new Error('Session credential type not advertised.')
      if (resume && (!('channelId' in plan) || plan.channelId !== resume || plan.action === 'open' || (plan.action === 'voucher' && plan.deposit?.action === 'open'))) throw new Error('Resume channel mismatch.')
      if ('channelId' in plan && plan.action !== 'open' && !(plan.action === 'voucher' && plan.deposit?.action === 'open')) {
        const current = await readChannel(plan.channelId, plan.action === 'topUp' || plan.action === 'close', plan.action !== 'topUp' || plan.type === 'hash')
        const funding = plan.action === 'voucher' ? plan.deposit : undefined
        const additional = plan.action === 'topUp' ? BigInt(plan.additionalDeposit) : funding ? BigInt('value' in funding.authorization ? funding.authorization.value : funding.authorization.permitted.amount) : 0n
        const deposit = BigInt(current.deposit) + additional
        if (deposit >= 1n << 128n) throw new Error('Deposit exceeds uint128.')
        if ('cumulativeAmount' in plan && BigInt(plan.cumulativeAmount) > deposit) throw new Error('Voucher exceeds the channel deposit.')
        // Settled funds can still represent prepaid service. Only the server knows spent credit.
        if (plan.action === 'voucher' && deposit < BigInt(request.amount)) throw new Error('Channel deposit does not cover one service unit.')
      }
      S.assertClientPolicy(plan, policy)
      if (typeof wallet.signRequest !== 'function') throw new Error('Session wallet must support request signing.')
      const payload = S.PayloadSchema.parse(await wallet.createPayload(request, plan, policy))
      if ('type' in payload && !(request.methodDetails.credentialTypes ?? ['hash']).includes(payload.type)) throw new Error('Session credential type not advertised.')
      if ('cumulativeAmount' in payload && BigInt(payload.cumulativeAmount) > BigInt(P.Uint128Schema.parse(parameters.maxCumulativeAmount))) throw new Error('Voucher exceeds client cumulative limit.')
      if (request.methodDetails.channelId && payload.channelId !== request.methodDetails.channelId) throw new Error('Resume channel mismatch.')
      if (payload.action !== plan.action || ('channelId' in plan && payload.channelId !== plan.channelId) ||
          ('cumulativeAmount' in plan && (!('cumulativeAmount' in payload) || payload.cumulativeAmount !== plan.cumulativeAmount))) throw new Error('Wallet did not execute the approved payment plan.')
      S.assertClientPolicy(plan, policy)
      const authorized = await authorizeSessionRequest({ ...challenge, request }, payload, data => wallet.signRequest(data, payload.action))
      S.assertClientPolicy(plan, policy)
      return Credential.serialize(Credential.from({ challenge, payload: authorized, source: P.formatSource(parameters.payer, request.methodDetails.chainId) }))
    },
  })
}

/** Authenticate a manually prepared payload without changing its settlement signature. */
export async function authorizeSessionRequest(challenge: S.Challenge, payload: S.Payload, signTypedData: P.TypedSigner): Promise<S.Payload> {
  const nonce = `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')}` as Hex
  const signature = await signTypedData(S.requestAuthorizationTypedData(challenge, payload, nonce))
  return S.PayloadSchema.parse({ ...payload, requestAuthorization: { nonce, signature } })
}

export async function signVoucher(parameters: {
  chainId: number; escrowContract: string; channelId: Hex; cumulativeAmount: string;
  signTypedData: P.TypedSigner
}): Promise<Extract<S.Payload, { action: 'voucher' }>> {
  const signature = await parameters.signTypedData(P.voucherTypedData(parameters))
  P.assertSignature(signature)
  return { action: 'voucher', channelId: parameters.channelId, cumulativeAmount: parameters.cumulativeAmount, signature }
}
