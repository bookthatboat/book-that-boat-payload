import config from '@/payload.config'
import { getPayload } from 'payload'

const parseLengthFt = (value: unknown): number | undefined => {
  const raw = String(value ?? '').trim()
  const match = raw.match(/\d+(\.\d+)?/)

  if (!match) return undefined

  const length = Number(match[0])
  return Number.isFinite(length) ? length : undefined
}

export async function POST(req: Request) {
  const secret = req.headers.get('x-backfill-secret')

  if (!process.env.BACKFILL_SECRET || secret !== process.env.BACKFILL_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const payload = await getPayload({ config })

  const boats = await payload.find({
    collection: 'boats',
    depth: 0,
    limit: 1000,
    overrideAccess: true,
  })

  let updated = 0
  const results: Array<{
    id: string
    name?: string
    lengthRaw?: unknown
    lengthFt?: number
    reservationCount: number
  }> = []

  for (const boat of boats.docs as any[]) {
    const lengthRaw = boat.boatSpecifications?.length
    const lengthFt = parseLengthFt(lengthRaw)

    const reservations = await payload.find({
      collection: 'reservations',
      where: {
        boat: {
          equals: boat.id,
        },
      },
      depth: 0,
      limit: 0,
      overrideAccess: true,
    })

    const reservationCount = Number(reservations.totalDocs || 0)

    await payload.update({
      collection: 'boats',
      id: boat.id,
      data: {
        ...(typeof lengthFt === 'number' ? { lengthFt } : {}),
        reservationCount,
      },
      overrideAccess: true,
    })

    updated += 1

    results.push({
      id: boat.id,
      name: boat.name,
      lengthRaw,
      lengthFt,
      reservationCount,
    })
  }

  return Response.json({
    success: true,
    updated,
    results,
  })
}
