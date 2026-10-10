// app/real-estate/[id]/activity/page.tsx
import { requireProperty } from '@/lib/viewer'
import { activity, activityYears } from '@/lib/views'
import ActivityList from '../../_ui/ActivityList'

export default async function Activity({
  params, searchParams,
}: {
  params: Promise<{ id: string }>; searchParams: Promise<{ year?: string; q?: string }>
}) {
  const { id } = await params
  const { property: p } = await requireProperty(Number(id))
  const sp = await searchParams
  const years = await activityYears({ propertyId: p.id })
  const thisYear = new Date().getFullYear()
  if (!years.includes(thisYear)) years.unshift(thisYear)
  const year = /^\d{4}$/.test(sp.year || '') && years.includes(Number(sp.year)) ? Number(sp.year) : years[0]
  const search = (sp.q || '').slice(0, 100)
  const rows = await activity({ propertyId: p.id, year, search })
  return <ActivityList rows={rows} years={years} year={year} search={search} basePath={`/real-estate/${p.id}/activity`} />
}
