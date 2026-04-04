import axios from 'axios'

const API_URL = process.env.NEXT_PUBLIC_API_URL!

export const api = axios.create({
  baseURL: API_URL,
})

// Attach JWT token to every request automatically
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('hookdrop_token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// Handle 401 — redirect to login
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('hookdrop_token')
      localStorage.removeItem('hookdrop_user')
      window.location.href = '/auth/login'
    }
    return Promise.reject(error)
  }
)
