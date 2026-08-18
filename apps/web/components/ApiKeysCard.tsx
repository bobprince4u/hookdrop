'use client'

import { useCallback, useEffect, useState } from 'react'
import { api, describeApiError } from '@/lib/api'

/**
 * API key management (H-27).
 *
 * ## What this replaces
 *
 * The settings page used to offer a "Copy API token" button that read the raw access JWT
 * out of `localStorage` and put it on the clipboard, captioned "Use this to authenticate
 * direct API requests." Everything about that was wrong: the token could not be revoked
 * without rotating `JWT_SECRET` for every user at once, it carried full session authority
 * including account-security operations, and it was pasted into scripts and CI
 * configuration as though it were a durable credential.
 *
 * H-16 shortens that token to fifteen minutes and moves it out of `localStorage`
 * entirely, so the button could not keep working even in principle. The capability it
 * advertised is real, though, so it is replaced rather than removed: `hdk_` keys are
 * scoped, individually revocable, and hashed at rest.
 *
 * ## Why the plaintext key is shown exactly once
 *
 * The server stores only `HMAC-SHA256(key, pepper)`. No endpoint can return the key
 * again, because no endpoint has it — which is the property that makes a leaked database
 * dump useless. The panel below therefore states that plainly at the moment of issue
 * rather than letting a user discover it later.
 */

interface ApiKeySummary {
  id: string
  name: string
  prefix: string
  last_used_at: string | null
  expires_at: string | null
  created_at: string
}

/**
 * The backend accepts 1–730 days or no expiry at all. These are the choices worth
 * offering; a key that outlives the integration it was made for is the common failure.
 */
const EXPIRY_CHOICES: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: '90 days', days: 90 },
  { label: '30 days', days: 30 },
  { label: '1 year', days: 365 },
  { label: 'No expiry', days: null },
]

const formatDate = (value: string | null): string =>
  value ? new Date(value).toLocaleDateString() : '—'

export default function ApiKeysCard() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([])
  const [limit, setLimit] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [expiryDays, setExpiryDays] = useState<number | null>(
    EXPIRY_CHOICES[0].days
  )
  const [creating, setCreating] = useState(false)

  /** The plaintext key, held only until the user dismisses it. Never persisted. */
  const [issued, setIssued] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const res = await api.get('/api/keys')
      setKeys(Array.isArray(res.data?.api_keys) ? res.data.api_keys : [])
      setLimit(typeof res.data?.limit === 'number' ? res.data.limit : null)
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const createKey = async () => {
    if (!name.trim() || creating) return

    setCreating(true)
    setError(null)
    try {
      const res = await api.post('/api/keys', {
        name: name.trim(),
        ...(expiryDays === null ? {} : { expires_in_days: expiryDays }),
      })

      const key = res.data?.key
      const record = res.data?.api_key

      if (typeof key !== 'string' || !record) {
        setError('The key was created but the response was unreadable.')
        await load()
        return
      }

      setIssued(key)
      setCopied(false)
      setKeys((previous) => [record as ApiKeySummary, ...previous])
      setName('')
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setCreating(false)
    }
  }

  const revokeKey = async (id: string, keyName: string) => {
    if (
      !window.confirm(
        `Revoke "${keyName}"? Any integration using it stops working immediately, and this cannot be undone.`
      )
    ) {
      return
    }

    setRevoking(id)
    setError(null)
    try {
      await api.delete(`/api/keys/${id}`)
      setKeys((previous) => previous.filter((key) => key.id !== id))
    } catch (err) {
      setError(describeApiError(err))
    } finally {
      setRevoking(null)
    }
  }

  const copyIssued = async () => {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused by the browser. The key is on screen and
      // selectable, so there is nothing to recover from.
      setError('Could not write to the clipboard — copy the key manually.')
    }
  }

  const atLimit = limit !== null && keys.length >= limit

  return (
    <div
      className="rounded-2xl border border-white/5 p-6 mb-4"
      style={{ background: 'rgba(255,255,255,0.02)' }}
    >
      <h2 className="text-sm font-medium mb-1">API keys</h2>
      <p className="text-xs text-zinc-500 mb-4">
        Authenticate direct API requests with{' '}
        <code className="text-zinc-400">Authorization: Bearer hdk_…</code>. Keys
        cannot manage other keys, sessions, or billing.
      </p>

      {issued && (
        <div
          className="mb-5 p-4 rounded-xl"
          style={{
            background: 'rgba(79,70,229,0.08)',
            border: '1px solid rgba(79,70,229,0.25)',
          }}
        >
          <p className="text-xs font-medium text-indigo-300 mb-2">
            Copy this key now — it cannot be shown again.
          </p>
          <code className="block text-xs break-all text-zinc-200 mb-3 select-all">
            {issued}
          </code>
          <div className="flex gap-2">
            <button
              onClick={copyIssued}
              className="text-xs border border-white/10 hover:border-white/20 px-3 py-1.5 rounded-lg transition-colors"
            >
              {copied ? '✓ Copied' : 'Copy key'}
            </button>
            <button
              onClick={() => setIssued(null)}
              className="text-xs text-zinc-500 hover:text-zinc-300 px-3 py-1.5 rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-2 mb-5">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void createKey()
          }}
          maxLength={100}
          placeholder="Key name (e.g. CI deploy)"
          aria-label="API key name"
          className="flex-1 text-sm bg-transparent border border-white/10 focus:border-white/25 rounded-xl px-3 py-2 outline-none transition-colors"
        />
        <select
          value={expiryDays === null ? '' : String(expiryDays)}
          onChange={(event) =>
            setExpiryDays(
              event.target.value === '' ? null : Number(event.target.value)
            )
          }
          aria-label="Key expiry"
          className="text-sm border border-white/10 focus:border-white/25 rounded-xl px-3 py-2 outline-none transition-colors"
          style={{ background: '#0B1120' }}
        >
          {EXPIRY_CHOICES.map((choice) => (
            <option
              key={choice.label}
              value={choice.days === null ? '' : String(choice.days)}
            >
              {choice.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => void createKey()}
          disabled={creating || atLimit || name.trim().length === 0}
          className="text-sm font-medium px-4 py-2 rounded-xl text-white transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: 'linear-gradient(135deg, #3B82F6 0%, #4F46E5 100%)',
          }}
        >
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </div>

      {atLimit && (
        <p className="text-xs text-amber-400/80 mb-4">
          You have reached the limit of {limit} active keys. Revoke one to create
          another.
        </p>
      )}

      {error && <p className="text-xs text-red-400 mb-4">{error}</p>}

      {loading ? (
        <p className="text-xs text-zinc-500 animate-pulse">Loading keys…</p>
      ) : keys.length === 0 ? (
        <p className="text-xs text-zinc-500">No API keys yet.</p>
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex items-center justify-between gap-4 py-2.5 border-b border-white/5 last:border-0"
            >
              <div className="min-w-0">
                <p className="text-sm truncate">{key.name}</p>
                <p className="text-xs text-zinc-500">
                  <code className="text-zinc-400">{key.prefix}…</code> · created{' '}
                  {formatDate(key.created_at)} · last used{' '}
                  {formatDate(key.last_used_at)}
                  {key.expires_at
                    ? ` · expires ${formatDate(key.expires_at)}`
                    : ' · no expiry'}
                </p>
              </div>
              <button
                onClick={() => void revokeKey(key.id, key.name)}
                disabled={revoking === key.id}
                className="shrink-0 text-xs border border-white/10 hover:border-red-500/50 hover:text-red-400 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40"
              >
                {revoking === key.id ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
