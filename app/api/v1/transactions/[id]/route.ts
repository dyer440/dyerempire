// app/api/v1/transactions/[id]/route.ts
import { route, pathId } from '@/lib/api/http'
import { getTransaction, updateTransaction, deleteForecast } from '@/lib/api/service'

type P = { id: string }

export const GET = route<P>('read', async ({ params }) => getTransaction(pathId(params.id)))

export const PATCH = route<P>('write', async ({ params, body, who }) =>
  updateTransaction(pathId(params.id), await body(), who),
)

// Forecast rows only; actuals are refused with 409 not_forecast.
export const DELETE = route<P>('write', async ({ params, who }) => deleteForecast(pathId(params.id), who))
