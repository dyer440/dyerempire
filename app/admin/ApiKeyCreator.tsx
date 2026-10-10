'use client'
// app/admin/ApiKeyCreator.tsx
// Form for minting a bot key. Uses useActionState so the new key comes back to
// this component directly and is shown once, without ever touching a cookie,
// the URL, or the database in plaintext.
import { useActionState, useState } from 'react'
import { createApiKey, type CreateKeyState } from './api-key-actions'

const input =
  'rounded-md border border-rule bg-paper px-3 py-2 text-[15px] placeholder:text-faint focus:border-brass focus:outline-none'

export default function ApiKeyCreator() {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createApiKey, { status: 'idle' })
  const [copied, setCopied] = useState(false)

  return (
    <div className="rounded-lg border border-rule bg-surface p-4">
      <h3 className="mb-3 text-[15px] font-medium">New key</h3>
      <form action={action} className="flex flex-col gap-3">
        <input name="name" placeholder="Bot name, e.g. GrokBot" required className={input} />
        <div className="flex flex-wrap gap-4 text-[14px] text-muted">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="scopes" value="read" defaultChecked className="accent-ink" /> read
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="scopes" value="write" className="accent-ink" /> write
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="scopes" value="sql" className="accent-ink" /> sql (read-only queries)
          </label>
        </div>
        <input name="expires_days" type="number" min={1} placeholder="Expires after N days (blank = never)" className={input} />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-ink px-4 py-2 text-[14px] font-medium text-white hover:bg-ink/90 disabled:opacity-50"
        >
          {pending ? 'Creating' : 'Create key'}
        </button>
      </form>

      {state.status === 'error' && <p className="mt-4 text-[14px] text-late">{state.message}</p>}

      {state.status === 'created' && (
        <div className="mt-4 rounded-md border border-due/40 bg-due-wash/50 p-4">
          <p className="mb-2 text-[14px] text-due">
            Key for {state.name} ({state.scopes.join(', ')}). Copy it now; it will not be shown again.
          </p>
          <code className="block select-all break-all rounded bg-surface p-3 text-[14px] text-ink">{state.key}</code>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(state.key).then(() => setCopied(true), () => setCopied(false))
            }}
            className="mt-3 text-[14px] text-muted hover:text-ink"
          >
            {copied ? 'Copied' : 'Copy to clipboard'}
          </button>
        </div>
      )}
    </div>
  )
}
