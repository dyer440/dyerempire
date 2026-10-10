// app/real-estate/notes/page.tsx
// The note box and what became of each note.
import { redirect } from 'next/navigation'
import { getViewer } from '@/lib/viewer'
import { listNotes } from '@/lib/notes'
import NoteBox from '../_ui/NoteBox'

const label = { open: 'Waiting', done: 'Done', dismissed: 'Nothing to post' } as const
const tone = { open: 'bg-due-wash text-due', done: 'bg-paid-wash text-paid', dismissed: 'bg-wash text-muted' } as const

export default async function Notes() {
  const v = await getViewer()
  if (!v.insider) redirect('/real-estate')
  const notes = await listNotes({ status: 'all', limit: 200 })

  return (
    <main className="max-w-3xl space-y-8">
      <h1 className="font-serif text-4xl font-medium tracking-tight">Notes</h1>
      <NoteBox properties={v.properties.map((p) => ({ id: p.id, name: p.name }))} />
      <section aria-labelledby="sent-h">
        <h2 id="sent-h" className="font-serif text-2xl">Sent</h2>
        {notes.length === 0 ? (
          <p className="mt-3 text-muted">No notes yet.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {notes.map((n) => (
              <li key={n.id} className="rounded-lg border border-rule bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted">
                  <span>{n.author_name || n.author_email}, {fmtWhen(n.created_at)}{n.property ? `, ${n.property}` : ''}</span>
                  <span className={`rounded px-2 py-0.5 font-medium ${tone[n.status]}`}>{label[n.status]}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[15px]">{n.body}</p>
                {n.reply && (
                  <p className="mt-3 border-l-2 border-rule pl-3 text-[14px] text-ink/80">
                    {n.reply} <span className="text-muted">({(n.resolved_by || "").replace(/^bot:/, "")}, {fmtWhen(n.resolved_at!)})</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

function fmtWhen(s: string) {
  const d = new Date(s.replace(' ', 'T') + ':00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
