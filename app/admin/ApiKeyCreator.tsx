'use client'
// app/admin/ApiKeyCreator.tsx
// Form for minting a bot key. Uses useActionState so the new key comes back to
// this component directly and is shown once, without ever touching a cookie,
// the URL, or the database in plaintext.
import { useActionState, useState } from 'react'
import { createApiKey, type CreateKeyState } from './api-key-actions'

const input =
  'bg-white/5 border border-white/20 px-4 py-2 text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 text-sm'

export default function ApiKeyCreator() {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createApiKey, { status: 'idle' })
  const [copied, setCopied] = useState(false)

  return (
    <div className="mb-10 border border-white/10 p-6">
      <h2 className="text-sm tracking-widest uppercase text-white/50 mb-4">New Bot API Key</h2>
      <form action={action} className="flex flex-col gap-3">
        <input name="name" placeholder="Bot name, e.g. GrokBot" required className={input} />
        <div className="flex flex-wrap gap-4 text-sm text-white/70">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="scopes" value="read" defaultChecked className="accent-blue-400" /> read
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="scopes" value="write" className="accent-blue-400" /> write
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="scopes" value="sql" className="accent-blue-400" /> sql (read-only queries)
          </label>
        </div>
        <input name="expires_days" type="number" min={1} placeholder="Expires after N days (blank = never)" className={input} />
        <button
          type="submit"
          disabled={pending}
          className="border border-white/30 px-6 py-2 text-sm tracking-widest uppercase hover:bg-white/10 transition-all self-start disabled:opacity-40"
        >
          {pending ? 'Creating…' : 'Create key'}
        </button>
      </form>

      {state.status === 'error' && <p className="mt-4 text-sm text-red-400">{state.message}</p>}

      {state.status === 'created' && (
        <div className="mt-5 border border-amber-400/40 bg-amber-400/5 p-4">
          <p className="text-xs tracking-widest uppercase text-amber-300 mb-2">
            Key for {state.name} ({state.scopes.join(', ')}). Copy it now; it will not be shown again.
          </p>
          <code className="block break-all text-sm text-white bg-black/60 p-3 select-all">{state.key}</code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(state.key).then(() => setCopied(true), () => setCopied(false))
            }}
            className="mt-3 text-xs tracking-widest uppercase text-white/60 hover:text-white"
          >
            {copied ? 'Copied' : 'Copy to clipboard'}
          </button>
        </div>
      )}
    </div>
  )
}
