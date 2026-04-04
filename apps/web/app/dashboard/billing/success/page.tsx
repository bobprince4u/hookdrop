import { Suspense } from 'react'
import BillingSuccessContent from './success-content'

export default function BillingSuccessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#030712' }}>
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    }>
      <BillingSuccessContent />
    </Suspense>
  )
}
