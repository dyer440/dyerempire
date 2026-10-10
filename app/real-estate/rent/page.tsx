// app/real-estate/rent/page.tsx
// Every rented unit the viewer can see, one row each, for a whole year.
import Link from 'next/link'
import { getViewer } from '@/lib/viewer'
import { rentGrid } from '@/lib/views'
import RentTable from '../_ui/RentTable'
import { RentLegend } from '../_ui/RentStrip'

export default async function RentRoll({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const v = await getViewer()
  const sp = await searchParams
  const thisYear = new Date().getFullYear()
  const year = /^\d{4}$/.test(sp.year || '') ? Math.min(Number(sp.year), thisYear + 1) : thisYear
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
  const lines = await rentGrid(v.properties.map((p) => p.id), months)

  return (
    <main className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-serif text-4xl font-medium tracking-tight">Rent roll {year}</h1>
        <nav aria-label="Year" className="flex gap-4 text-[15px]">
          <Link href={`?year=${year - 1}`} className="text-muted hover:text-ink">{year - 1}</Link>
          {year < thisYear && <Link href={`?year=${year + 1}`} className="text-muted hover:text-ink">{year + 1}</Link>}
        </nav>
      </div>
      <p className="max-w-2xl text-[15px] text-muted">
        Rent counts in the month it was for, even when it is paid a few days into the next month.
      </p>
      {lines.length === 0 ? <p className="text-muted">No rent recorded in {year}.</p> : <RentTable lines={lines} months={months} showProperty />}
      <RentLegend />
    </main>
  )
}
