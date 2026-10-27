import { Method } from 'mppx'
import { z } from 'mppx'
import { parseUnits } from 'viem'

import * as Types from './Types.js'

export const charge = Method.from({
  name: Types.paymentMethod,
  intent: Types.chargeIntent,
  schema: {
    credential: {
      payload: Types.ChargePayloadSchema,
    },
    request: z.pipe(
      Types.ChargeRequestInputSchema,
      z.transform(
        ({
          amount,
          asset,
          currency,
          decimals,
          minConfirmations,
          network,
          recipient,
          ...request
        }: Types.ChargeRequestInput): Types.ChargeRequest => {
          const normalizedAsset = Types.normalizeAsset(asset, decimals)
          if (currency !== undefined && currency !== Types.currencyOf(normalizedAsset)) {
            throw new Error('TRON currency does not match the payment asset.')
          }
          return {
            ...request,
            amount: parseUnits(amount, normalizedAsset.decimals).toString(),
            currency: currency ?? Types.currencyOf(normalizedAsset),
            methodDetails: {
              asset: normalizedAsset,
              ...(minConfirmations !== undefined ? { minConfirmations } : {}),
              network,
            },
            recipient,
          }
        },
      ),
    ),
  },
})
