import type { Endpoint } from 'payload'

const ACTIVE_STATUSES = ['pending', 'awaiting payment', 'confirmed_balance_due', 'confirmed']
const MAMO_FEE_PERCENTAGE = 4

const toNumber = (value: unknown, fallback = 0) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const toId = (value: any) => {
  if (!value) return ''
  if (typeof value === 'string') return value
  return String(value.id || value._id || '')
}

const toDubaiDate = (date: string, time: string) => new Date(`${date}T${time || '10:00'}:00+04:00`)

const addHours = (date: Date, hours: number) => new Date(date.getTime() + hours * 60 * 60 * 1000)

const money = (value: number) => Math.max(0, Math.round(value))

const getLocationName = (location: any) => {
  if (!location) return ''
  if (typeof location === 'string') return location
  return location.harbour || location.displayName || location.name || location.city || ''
}

const getSupplier = (boat: any) => {
  const owner = boat?.owner
  return owner && typeof owner === 'object' ? owner : null
}

const getBoatImage = (boat: any) => {
  if (boat?.media && typeof boat.media === 'object') return boat.media.url || ''
  const first = Array.isArray(boat?.gallery) ? boat.gallery[0]?.image : null
  return first && typeof first === 'object' ? first.url || '' : ''
}

const normalizePaymentMethod = (value: string) => {
  if (value === 'Cash' || value === 'Bank Transfer' || value === 'Mamo Pay') return value
  return 'Mamo Pay'
}

const getFeeFields = (amount: number, method: string) => {
  const safeAmount = money(amount)

  if (method !== 'Mamo Pay') {
    return {
      processingFeePercentage: 0,
      processingFeeAmount: 0,
      customerPayableAmount: safeAmount,
    }
  }

  const processingFeeAmount = money(safeAmount * (MAMO_FEE_PERCENTAGE / 100))

  return {
    processingFeePercentage: MAMO_FEE_PERCENTAGE,
    processingFeeAmount,
    customerPayableAmount: safeAmount + processingFeeAmount,
  }
}

const getRequestBody = async (req: any) => {
  if (typeof req.json === 'function') {
    return await req.json().catch(() => ({}))
  }

  return req.body || {}
}

const getBookingTimes = (body: any) => {
  const date = String(body?.date || '').trim()
  const startTime = String(body?.startTime || '').trim()
  const duration = Math.max(1, toNumber(body?.duration, 1))

  if (!date || !startTime) {
    throw new Error('Date and start time are required.')
  }

  const start = toDubaiDate(date, startTime)
  const end = addHours(start, duration)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid date or time.')
  }

  return { date, startTime, duration, start, end }
}

const getBookedBoatIds = async ({ payload, start, end }: { payload: any; start: Date; end: Date }) => {
  const reservations = await payload.find({
    collection: 'reservations',
    depth: 0,
    limit: 1000,
    overrideAccess: true,
    where: {
      and: [
        { status: { in: ACTIVE_STATUSES } },
        { startTime: { less_than: end.toISOString() } },
        { endTime: { greater_than: start.toISOString() } },
      ],
    },
  })

  return new Set((reservations.docs || []).map((reservation: any) => toId(reservation.boat)).filter(Boolean))
}

const mapBoat = (boat: any) => {
  const supplier = getSupplier(boat)
  const price = toNumber(boat.salePrice, 0) > 0 ? toNumber(boat.salePrice, 0) : toNumber(boat.price, 0)

  return {
    id: String(boat.id),
    name: boat.name || '',
    slug: boat.slug || '',
    image: getBoatImage(boat),
    price,
    priceDay: toNumber(boat.priceDay, 0),
    minHours: toNumber(boat.minHours, 1),
    capacity: toNumber(boat.boatSpecifications?.capacity, 0),
    length: boat.boatSpecifications?.length || '',
    type: boat.boatSpecifications?.type || boat.type || '',
    harbour: getLocationName(boat.location),
    locationId: toId(boat.location),
    supplierId: supplier?.id || '',
    supplierName: supplier?.name || supplier?.title || '',
    supplierPhone: `${supplier?.countryCode || ''}${supplier?.contactNumber || ''}`.trim(),
  }
}

const mapExtra = (extra: any) => ({
  id: String(extra.id),
  name: extra.name || '',
  category: extra.category || '',
  price: toNumber(extra.unitPrice, 0),
})

const mapCoupon = (coupon: any) => ({
  id: String(coupon.id),
  code: coupon.code || '',
  type: coupon.type || '',
  amount: toNumber(coupon.amount, 0),
  isActive: Boolean(coupon.isActive),
  expiresAt: coupon.expiresAt || '',
  applyToAllBoats: Boolean(coupon.applyToAllBoats),
  boats: Array.isArray(coupon.boats) ? coupon.boats.map(toId).filter(Boolean) : [],
})

const validateCoupon = (coupon: any, boatId: string, subtotal: number) => {
  if (!coupon?.id || !coupon.isActive) return { discount: 0, message: '' }

  if (coupon.expiresAt) {
    const expires = new Date(coupon.expiresAt)
    if (!Number.isNaN(expires.getTime()) && expires < new Date()) {
      return { discount: 0, message: 'Coupon is expired.' }
    }
  }

  if (!coupon.applyToAllBoats) {
    const boatIds = Array.isArray(coupon.boats) ? coupon.boats.map(toId).filter(Boolean) : []
    if (boatIds.length > 0 && !boatIds.includes(boatId)) {
      return { discount: 0, message: 'Coupon is not valid for this yacht.' }
    }
  }

  const amount = toNumber(coupon.amount, 0)
  const discount =
    coupon.type === 'percentage'
      ? subtotal * (amount / 100)
      : coupon.type === 'fixed'
        ? amount
        : 0

  return { discount: Math.min(subtotal, money(discount)), message: '' }
}

const calculatePrice = async ({ payload, body }: { payload: any; body: any }) => {
  const { duration, start, end } = getBookingTimes(body)
  const boatId = String(body.boatId || '').trim()
  if (!boatId) throw new Error('Boat is required.')

  const boat = await payload.findByID({
    collection: 'boats',
    id: boatId,
    depth: 1,
    overrideAccess: true,
  })

  const baseHourlyPrice = toNumber(boat.salePrice, 0) > 0 ? toNumber(boat.salePrice, 0) : toNumber(boat.price, 0)
  const yachtSubtotal = money(baseHourlyPrice * duration)

  const selectedExtras = Array.isArray(body.extras) ? body.extras : []
  const extrasRows = []
  let extrasSubtotal = 0

  for (const row of selectedExtras) {
    const extraId = String(row.extraId || row.id || '').trim()
    const quantity = Math.max(1, toNumber(row.quantity, 1))
    if (!extraId) continue

    const extra = await payload.findByID({
      collection: 'extras',
      id: extraId,
      depth: 0,
      overrideAccess: true,
    })

    const unitPrice = toNumber(extra.unitPrice, 0)
    extrasSubtotal += unitPrice * quantity
    extrasRows.push({
      extra: extraId,
      quantity,
      unitPrice,
      name: extra.name || '',
      total: unitPrice * quantity,
    })
  }

  const otherExtrasRows = (Array.isArray(body.otherExtras) ? body.otherExtras : [])
    .map((row: any) => ({
      name: String(row.name || '').trim(),
      price: toNumber(row.price, 0),
      quantity: Math.max(1, toNumber(row.quantity, 1)),
    }))
    .filter((row: any) => row.name && row.price > 0)

  const otherExtrasSubtotal = otherExtrasRows.reduce((sum: number, row: any) => sum + row.price * row.quantity, 0)
  const subtotalBeforeDiscount = money(yachtSubtotal + extrasSubtotal + otherExtrasSubtotal)

  let coupon: any = null
  const couponId = String(body.couponId || '').trim()
  const couponCode = String(body.couponCode || '').trim().toUpperCase()

  if (couponId) {
    coupon = await payload.findByID({ collection: 'coupons', id: couponId, depth: 0, overrideAccess: true })
  } else if (couponCode) {
    const found = await payload.find({
      collection: 'coupons',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { code: { equals: couponCode } },
    })
    coupon = found.docs?.[0] || null
  }

  const couponResult = validateCoupon(coupon, boatId, subtotalBeforeDiscount)
  const customDiscountAmount = Math.max(0, toNumber(body.customDiscountAmount, 0))
  const customDiscount = Math.min(subtotalBeforeDiscount, customDiscountAmount)
  const totalDiscount = Math.min(subtotalBeforeDiscount, couponResult.discount + customDiscount)
  const totalPrice = money(subtotalBeforeDiscount - totalDiscount)

  return {
    boat,
    start,
    end,
    duration,
    baseHourlyPrice,
    yachtSubtotal,
    extrasRows,
    extrasSubtotal: money(extrasSubtotal),
    otherExtrasRows,
    otherExtrasSubtotal: money(otherExtrasSubtotal),
    subtotalBeforeDiscount,
    coupon: coupon ? mapCoupon(coupon) : null,
    couponDiscount: couponResult.discount,
    couponMessage: couponResult.message,
    customDiscount,
    totalDiscount,
    totalPrice,
  }
}

const buildPayments = ({ body, totalPrice }: { body: any; totalPrice: number }) => {
  const now = new Date().toISOString()
  const rows = Array.isArray(body.payments) ? body.payments : []
  const defaultMethod = normalizePaymentMethod(String(body.method || 'Mamo Pay'))

  if (rows.length > 0) {
    return rows
      .map((row: any, index: number) => {
        const amount = money(toNumber(row.amount, 0))
        const method = normalizePaymentMethod(String(row.method || defaultMethod))
        const status = ['scheduled', 'pending', 'completed'].includes(row.status) ? row.status : 'scheduled'

        return {
          id: row.id || `desk-payment-${Date.now()}-${index}`,
          kind: row.kind || (rows.length === 1 ? 'full' : index === 0 ? 'downpayment' : 'balance'),
          createdAt: now,
          installedAt: status === 'pending' ? now : '',
          paidAt: status === 'completed' ? now : '',
          amount,
          method,
          ...getFeeFields(amount, method),
          date: row.date ? new Date(row.date).toISOString() : now,
          status,
          balance: Math.max(0, totalPrice - rows.slice(0, index + 1).reduce((sum: number, item: any) => sum + money(toNumber(item.amount, 0)), 0)),
          installmentStage: status === 'completed' ? 'paid' : status === 'pending' ? 'installed_ready_to_be_paid' : 'ready_to_be_installed',
          notes: row.notes || 'Created from Reservation Desk.',
        }
      })
      .filter((row: any) => row.amount > 0)
  }

  return [
    {
      id: `desk-payment-${Date.now()}`,
      kind: 'full',
      createdAt: now,
      installedAt: '',
      amount: totalPrice,
      method: defaultMethod,
      ...getFeeFields(totalPrice, defaultMethod),
      date: now,
      status: 'scheduled',
      balance: totalPrice,
      installmentStage: 'ready_to_be_installed',
      notes: 'Created from Reservation Desk.',
    },
  ]
}

export const reservationDeskEndpoints: Endpoint[] = [
  {
    path: '/reservation-desk/options',
    method: 'get',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })

      const [locations, extras, coupons] = await Promise.all([
        req.payload.find({ collection: 'locations', depth: 0, limit: 200, sort: 'harbour', overrideAccess: true }),
        req.payload.find({ collection: 'extras', depth: 0, limit: 200, sort: 'name', overrideAccess: true, where: { archived: { not_equals: true } } }),
        req.payload.find({ collection: 'coupons', depth: 0, limit: 200, sort: 'code', overrideAccess: true }),
      ])

      return Response.json({
        locations: locations.docs || [],
        extras: (extras.docs || []).map(mapExtra),
        coupons: (coupons.docs || []).map(mapCoupon),
      })
    },
  },
  {
    path: '/reservation-desk/available-boats',
    method: 'post',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })

      const body = await getRequestBody(req)
      const { start, end } = getBookingTimes(body)
      const guests = Math.max(1, toNumber(body.guests, 1))
      const harbour = String(body.harbour || '').trim().toLowerCase()
      const bookedBoatIds = await getBookedBoatIds({ payload: req.payload, start, end })

      const boats = await req.payload.find({
        collection: 'boats',
        depth: 1,
        limit: 200,
        overrideAccess: true,
        sort: '-reservationCount,-lengthFt',
        where: { archived: { not_equals: true } },
      })

      const docs = (boats.docs || [])
        .filter((boat: any) => !bookedBoatIds.has(String(boat.id)))
        .filter((boat: any) => toNumber(boat.boatSpecifications?.capacity, 0) >= guests)
        .filter((boat: any) => !harbour || getLocationName(boat.location).toLowerCase().includes(harbour))
        .map(mapBoat)

      return Response.json({ boats: docs, excludedBookedBoats: bookedBoatIds.size })
    },
  },
  {
    path: '/reservation-desk/price-preview',
    method: 'post',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })

      const body = await getRequestBody(req)
      const preview = await calculatePrice({ payload: req.payload, body })
      return Response.json({ preview })
    },
  },
  {
    path: '/reservation-desk/create',
    method: 'post',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })

      const body = await getRequestBody(req)
      const preview = await calculatePrice({ payload: req.payload, body })
      const boat = preview.boat as any
      const supplierId = toId(boat.owner)
      const locationName = getLocationName(boat.location)
      const status = ['pending', 'awaiting payment', 'confirmed_balance_due', 'confirmed'].includes(body.status)
        ? body.status
        : 'pending'
      const method = normalizePaymentMethod(String(body.method || 'Mamo Pay'))
      const payments = buildPayments({ body, totalPrice: preview.totalPrice })

      const doc = await req.payload.create({
        collection: 'reservations',
        data: {
          boat: String(boat.id),
          supplier: supplierId || undefined,
          departureLocation: locationName,
          meetingPointName: boat.meetingPointName || body.meetingPointName || '',
          meetingPointPin: boat.meetingPointPin || body.meetingPointPin || '',
          contactPersonName: boat.contactPersonName || body.contactPersonName || '',
          contactPersonNumber: boat.contactPersonNumber || body.contactPersonNumber || '',
          parkingLocationName: boat.parkingLocationName || body.parkingLocationName || '',
          parkingLocationPin: boat.parkingLocationPin || body.parkingLocationPin || '',
          user: String(body.guestName || '').trim(),
          guestEmail: String(body.guestEmail || '').trim(),
          countryCode: String(body.countryCode || '+971').trim(),
          guestPhone: String(body.guestPhone || '').trim(),
          guests: Math.max(1, toNumber(body.guests, 1)),
          startTime: preview.start.toISOString(),
          endTime: preview.end.toISOString(),
          status,
          specialRequests: String(body.specialRequests || '').trim(),
          extras: preview.extrasRows.map((row: any) => ({
            extra: row.extra,
            quantity: row.quantity,
            unitPrice: row.unitPrice,
          })),
          otherExtras: preview.otherExtrasRows,
          coupon: preview.coupon?.id || undefined,
          couponCode: preview.coupon?.code || '',
          customDiscountAmount: preview.customDiscount,
          totalPrice: preview.totalPrice,
          method,
          paymentMethod: payments.length > 1 ? 'scheduled' : 'full',
          payments,
          paymentsUpdateSource: 'payment-manager',
        } as any,
        overrideAccess: true,
        context: {
          paymentsUpdateSource: 'payment-manager',
        },
      })

      return Response.json({
        success: true,
        reservation: {
          id: doc.id,
          transactionId: (doc as any).transactionId,
          adminUrl: `/admin/collections/reservations/${doc.id}`,
          totalPrice: (doc as any).totalPrice,
          status: (doc as any).status,
        },
      })
    },
  },
]
