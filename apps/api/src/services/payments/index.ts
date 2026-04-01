import { PaymentProvider } from './provider.interface'
import { PaystackProvider } from './paystack.provider'
import { StripeProvider } from './stripe.provider'

const providers: Record<string, PaymentProvider> = {
  paystack: new PaystackProvider(),
  stripe: new StripeProvider(),
}

export const getProvider = (name: string): PaymentProvider => {
  const provider = providers[name]
  if (!provider) throw new Error(`Payment provider '${name}' not found`)
  return provider
}

export const defaultProvider = (): PaymentProvider => {
  const name = process.env.DEFAULT_PAYMENT_PROVIDER || 'paystack'
  return getProvider(name)
}

export * from './provider.interface'
