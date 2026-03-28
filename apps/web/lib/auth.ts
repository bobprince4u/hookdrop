import { create } from 'zustand'

interface User {
  id: string
  email: string
  name: string
  plan: string
}

interface AuthState {
  user: User | null
  token: string | null
  setAuth: (user: User, token: string) => void
  logout: () => void
  isAuthenticated: () => boolean
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: null,

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

  isAuthenticated: () => {
    return !!get().token
  },
}))

// Rehydrate from localStorage on page load
export const rehydrateAuth = () => {
  const token = localStorage.getItem('hookdrop_token')
  const userStr = localStorage.getItem('hookdrop_user')
  if (token && userStr) {
    const user = JSON.parse(userStr)
    useAuthStore.getState().setAuth(user, token)
  }
}
