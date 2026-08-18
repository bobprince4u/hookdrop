import { PaymentProvider } from './provider.interface'
import { PaystackProvider } from './paystack.provider'
import { FlutterwaveProvider } from './flutterwave.provider'
import { StripeProvider } from './stripe.provider'
import { env } from '../../config/env'

export type { PaymentProvider } from './provider.interface'
export type {
  InitializePaymentResult,
  TransactionConfirmation,
  WebhookVerificationResult,
} from './provider.interface'

const providers: Record<string, PaymentProvider> = {
  paystack: new PaystackProvider(),
  flutterwave: new FlutterwaveProvider(),
  stripe: new StripeProvider(),
}

export const isKnownProvider = (name: string): boolean => name in providers

export const getProvider = (name: string): PaymentProvider => {
  const provider = providers[name]
  if (!provider) throw new Error(`Payment provider '${name}' not found`)
  return provider
}

export const defaultProvider = (): PaymentProvider =>
  getProvider(env.DEFAULT_PAYMENT_PROVIDER)

// The previous `export * from './index'` re-exported this module from itself,
// which is a no-op at best and a circular reference at worst (H-36).
