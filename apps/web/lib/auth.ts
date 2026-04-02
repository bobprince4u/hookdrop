import { create } from 'zustand'
import { api } from './api'

interface User {
  id: string
  email: string
  name: string
  plan: string
}

interface AuthState {
  user: User | null
  token: string | null
  planLoading: boolean
  setAuth: (user: User, token: string) => void
  logout: () => void
  isAuthenticated: () => boolean
  refreshPlan: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,
  planLoading: false,

  setAuth: (user, token) => {
    localStorage.setItem('hookdrop_token', token)
    localStorage.setItem('hookdrop_user', JSON.stringify(user))
    set({ user, token })
  },

  logout: () => {
    localStorage.removeItem('hookdrop_token')
    localStorage.removeItem('hookdrop_user')
    set({ user: null, token: null })
    window.location.href = '/auth/login'
  },

  isAuthenticated: () => !!get().token,

  refreshPlan: async () => {
    try {
      set({ planLoading: true })
      const res = await api.get('/api/billing/current')
      const currentPlan = res.data.current_plan

      const user = get().user
      if (user && user.plan !== currentPlan) {
        const updatedUser = { ...user, plan: currentPlan }
        localStorage.setItem('hookdrop_user', JSON.stringify(updatedUser))
        set({ user: updatedUser })
      }
    } catch (err) {
      console.error('Plan refresh failed:', err)
    } finally {
      set({ planLoading: false })
    }
  },
}))

export const rehydrateAuth = () => {
  const token = localStorage.getItem('hookdrop_token')
  const userStr = localStorage.getItem('hookdrop_user')
  if (token && userStr) {
    const user = JSON.parse(userStr)
    useAuthStore.getState().setAuth(user, token)
  }
}
