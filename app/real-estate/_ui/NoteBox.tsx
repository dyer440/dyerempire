'use client'
// The note box: plain words in, nothing posted until Claude or GrokBot handle it.
import { useActionState, useEffect, useRef } from 'react'
import { sendNote, type NoteState } from '../notes/actions'

export default function NoteBox({ properties, compact = false }: {
  properties: { id: number; name: string }[]
  compact?: boolean
}) {
  const [state, action, pending] = useActionState<NoteState, FormData>(sendNote, null)
  const form = useRef<HTMLFormElement>(null)
  useEffect(() => { if (state?.ok) form.current?.reset() }, [state])

  return (
    <form ref={form} action={action} className="rounded-lg border border-rule bg-surface p-4">
      <label htmlFor="note-body" className="block font-serif text-lg">Leave a note for the books</label>
      {!compact && (
        <p className="mt-1 text-[14px] text-muted">
          Cash rent, a check deposited, a bill that changed, anything the bank won&apos;t explain on its own.
          Claude or GrokBot will post it and reply here.
        </p>
      )}
      <textarea
        id="note-body" name="body" rows={compact ? 2 : 3} maxLength={2000} required
        placeholder="Billy Evans paid $155 cash for 500 West, August rent"
        className="mt-3 w-full resize-y rounded-md border border-rule bg-paper px-3 py-2 text-[15px] placeholder:text-faint focus:border-brass focus:outline-none"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-[14px] text-muted">
          <span className="sr-only">Property</span>
          <select name="property_id" defaultValue="" className="rounded-md border border-rule bg-surface px-2 py-1.5 text-[14px] text-ink">
            <option value="">Any property</option>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <button
          type="submit" disabled={pending}
          className="rounded-md bg-ink px-4 py-1.5 text-[14px] font-medium text-white hover:bg-ink/90 disabled:opacity-60"
        >
          {pending ? 'Sending' : 'Send note'}
        </button>
        {state && (
          <p role="status" className={`text-[14px] ${state.ok ? 'text-paid' : 'text-late'}`}>{state.message}</p>
        )}
      </div>
    </form>
  )
}
