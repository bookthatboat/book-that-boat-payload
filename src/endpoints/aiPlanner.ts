import OpenAI from 'openai'
import type { Endpoint } from 'payload'

const BLOCKING_STATUSES = ['pending', 'awaiting payment', 'confirmed_balance_due', 'confirmed']

const toNumber = (value: unknown, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const toId = (value: any) => {
  if (!value) return ''
  if (typeof value === 'string') return value
  return String(value.id || value._id || '')
}

const addDubaiTime = (date: string, time: string) => new Date(`${date}T${time || '10:00'}:00+04:00`)

const getHarbour = (boat: any) => {
  const location = boat.location
  if (location && typeof location === 'object') {
    return location.harbour || location.name || location.displayName || ''
  }
  return ''
}

const getBoatImageUrl = (boat: any) => {
  const media = boat.media
  if (media && typeof media === 'object') return media.url || ''
  const firstGalleryImage = Array.isArray(boat.gallery) ? boat.gallery[0]?.image : null
  if (firstGalleryImage && typeof firstGalleryImage === 'object') return firstGalleryImage.url || ''
  return ''
}

const cleanExtra = (extra: any) => ({
  id: String(extra.id),
  name: String(extra.name || ''),
  category: String(extra.category || ''),
  unitPrice: toNumber(extra.unitPrice, 0),
})

const fallbackRecommendations = (boats: any[], extras: any[], occasion: string, duration: number) => ({
  summary:
    boats.length > 0
      ? `I found ${boats.length} suitable yacht option${boats.length === 1 ? '' : 's'} for your ${occasion || 'trip'}.`
      : 'I could not find an available yacht for those details. Try adjusting the time, duration, guest count, or budget.',
  planningNotes:
    boats.length > 0
      ? `A ${duration}-hour cruise gives you time for boarding, a relaxed route, and selected add-ons.`
      : 'No matching yachts were available for the selected slot.',
  recommendations: boats.slice(0, 3).map((boat, index) => ({
    boatId: boat.id,
    fitScore: 92 - index * 5,
    headline: index === 0 ? 'Best overall fit' : 'Strong alternative',
    reason: `${boat.name} fits your guest count, timing, and selected preferences.`,
    suggestedExtraIds: extras.slice(index * 3, index * 3 + 3).map((extra) => extra.id),
  })),
})

export const aiPlannerEndpoints: Endpoint[] = [
  {
    path: '/ai-planner/recommendations',
    method: 'post',
    handler: async (req) => {
      try {
        const body = typeof req.json === 'function' ? await req.json() : ((req as any).data || {})

        const date = String(body.date || '').trim()
        const startTimeValue = String(body.startTime || '').trim()
        const duration = Math.max(1, toNumber(body.duration, 2))
        const guests = Math.max(1, toNumber(body.guests, 1))
        const occasion = String(body.occasion || 'yacht trip').trim()
        const harbour = String(body.harbour || '').trim().toLowerCase()
        const vibe = String(body.vibe || '').trim()
        const budgetMin = toNumber(body.budgetMin, 0)
        const budgetMax = toNumber(body.budgetMax, 0)

        if (!date || !startTimeValue) {
          return Response.json({ message: 'Date and start time are required.' }, { status: 400 })
        }

        const startDateTime = addDubaiTime(date, startTimeValue)
        const endDateTime = new Date(startDateTime.getTime() + duration * 60 * 60 * 1000)

        if (Number.isNaN(startDateTime.getTime()) || Number.isNaN(endDateTime.getTime())) {
          return Response.json({ message: 'Invalid date or time.' }, { status: 400 })
        }

        const reservations = await req.payload.find({
          collection: 'reservations',
          depth: 0,
          limit: 1000,
          overrideAccess: true,
          where: {
            and: [
              { status: { in: BLOCKING_STATUSES } },
              { startTime: { less_than: endDateTime.toISOString() } },
              { endTime: { greater_than: startDateTime.toISOString() } },
            ],
          },
        })

        const bookedBoatIds = new Set(
          (reservations.docs || []).map((reservation: any) => toId(reservation.boat)).filter(Boolean),
        )

        const boatsResponse = await req.payload.find({
          collection: 'boats',
          depth: 1,
          limit: 100,
          overrideAccess: true,
          sort: '-reservationCount,-lengthFt',
          where: { archived: { not_equals: true } },
        })

        const extrasResponse = await req.payload.find({
          collection: 'extras',
          depth: 0,
          limit: 100,
          overrideAccess: true,
          where: { archived: { not_equals: true } },
        })

        const availableBoats = (boatsResponse.docs || [])
          .filter((boat: any) => !bookedBoatIds.has(String(boat.id)))
          .filter((boat: any) => toNumber(boat.boatSpecifications?.capacity, 0) >= guests)
          .filter((boat: any) => toNumber(boat.minHours, 1) <= duration)
          .filter((boat: any) => !harbour || getHarbour(boat).toLowerCase().includes(harbour))
          .filter((boat: any) => {
            if (!budgetMax) return true
            const price = toNumber(boat.salePrice, 0) > 0 ? toNumber(boat.salePrice, 0) : toNumber(boat.price, 0)
            const estimated = price * duration
            return estimated >= budgetMin && estimated <= budgetMax
          })
          .slice(0, 12)

        const extras = (extrasResponse.docs || []).map(cleanExtra)

        const boatSummaries = availableBoats.map((boat: any) => {
          const price = toNumber(boat.salePrice, 0) > 0 ? toNumber(boat.salePrice, 0) : toNumber(boat.price, 0)

          return {
            id: String(boat.id),
            name: String(boat.name || ''),
            slug: String(boat.slug || ''),
            type: String(boat.boatSpecifications?.type || boat.type || ''),
            capacity: toNumber(boat.boatSpecifications?.capacity, 0),
            length: String(boat.boatSpecifications?.length || ''),
            harbour: getHarbour(boat),
            pricePerHour: price,
            estimatedTotal: price * duration,
            minHours: toNumber(boat.minHours, 1),
            imageUrl: getBoatImageUrl(boat),
          }
        })

        let planner = fallbackRecommendations(boatSummaries, extras, occasion, duration)

        if (process.env.OPENAI_API_KEY && boatSummaries.length > 0) {
          try {
            const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
            const completion = await client.chat.completions.create({
              model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
              temperature: 0.5,
              response_format: { type: 'json_object' },
              messages: [
                {
                  role: 'system',
                  content:
                    'You are BTB AI Concierge: a luxury yacht concierge and friendly booking assistant. Return valid JSON only. Recommend only the provided boat IDs and extra IDs. Do not invent boats, prices, availability, extras, or policies.',
                },
                {
                  role: 'user',
                  content: JSON.stringify({
                    requiredJsonShape: {
                      summary: 'string',
                      planningNotes: 'string',
                      recommendations: [
                        {
                          boatId: 'string from boats',
                          fitScore: 'number 1-100',
                          headline: 'short string',
                          reason: 'string',
                          suggestedExtraIds: ['strings from extras'],
                        },
                      ],
                    },
                    customerRequest: {
                      date,
                      startTime: startTimeValue,
                      duration,
                      guests,
                      occasion,
                      harbour: body.harbour || '',
                      vibe,
                      budgetMin,
                      budgetMax,
                    },
                    boats: boatSummaries,
                    extras,
                  }),
                },
              ],
            })

            const parsed = JSON.parse(completion.choices[0]?.message?.content || '{}')
            if (Array.isArray(parsed?.recommendations)) planner = parsed
          } catch (error) {
            req.payload.logger.error(`[ai-planner] OpenAI failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }

        const validBoatIds = new Set(boatSummaries.map((boat) => boat.id))
        const validExtraIds = new Set(extras.map((extra) => extra.id))

        const recommendations = (planner.recommendations || [])
          .filter((item: any) => validBoatIds.has(String(item.boatId)))
          .slice(0, 3)
          .map((item: any) => {
            const boat = boatSummaries.find((candidate) => candidate.id === String(item.boatId))
            const suggestedExtras = (item.suggestedExtraIds || [])
              .filter((extraId: string) => validExtraIds.has(String(extraId)))
              .slice(0, 5)
              .map((extraId: string) => extras.find((extra) => extra.id === String(extraId)))
              .filter(Boolean)

            return { ...item, boat, suggestedExtras }
          })

        return Response.json({
          summary: planner.summary || '',
          planningNotes: planner.planningNotes || '',
          recommendations,
          availability: {
            requestedStartTime: startDateTime.toISOString(),
            requestedEndTime: endDateTime.toISOString(),
            excludedBookedBoats: bookedBoatIds.size,
            availableMatches: boatSummaries.length,
          },
        })
      } catch (error) {
        console.error('[ai-planner/recommendations] failed', error)
        return Response.json(
          { message: error instanceof Error ? error.message : 'Could not create AI planner recommendations.' },
          { status: 500 },
        )
      }
    },
  },
]
