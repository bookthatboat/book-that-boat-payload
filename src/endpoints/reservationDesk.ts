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

const getRequestBody = async (req: any) => {
  if (typeof req.json === 'function') return await req.json().catch(() => ({}))
  return req.body || {}
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
    return { processingFeePercentage: 0, processingFeeAmount: 0, customerPayableAmount: safeAmount }
  }

  const processingFeeAmount = money(safeAmount * (MAMO_FEE_PERCENTAGE / 100))
  return {
    processingFeePercentage: MAMO_FEE_PERCENTAGE,
    processingFeeAmount,
    customerPayableAmount: safeAmount + processingFeeAmount,
  }
}

const getBookingTimes = (body: any) => {
  const date = String(body?.date || '').trim()
  const startTime = String(body?.startTime || '').trim()
  const duration = Math.max(1, toNumber(body?.duration, 1))

  if (!date || !startTime) throw new Error('Date and start time are required.')

  const start = toDubaiDate(date, startTime)
  const end = addHours(start, duration)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid date or time.')
  }

  return { date, startTime, duration, start, end }
}

const getBookedBoatIds = async ({
  payload,
  start,
  end,
  excludeReservationId,
}: {
  payload: any
  start: Date
  end: Date
  excludeReservationId?: string
}) => {
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

  return new Set(
    (reservations.docs || [])
      .filter((reservation: any) => String(reservation.id) !== String(excludeReservationId || ''))
      .map((reservation: any) => toId(reservation.boat))
      .filter(Boolean),
  )
}

const mapBoat = (boat: any) => {
  const supplier = getSupplier(boat)
  const price = toNumber(boat.salePrice, 0) > 0 ? toNumber(boat.salePrice, 0) : toNumber(boat.price, 0)
  const extraIds = Array.isArray(boat.extras) ? boat.extras.map(toId).filter(Boolean) : []

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
    extraIds,
  }
}

const mapExtra = (extra: any) => ({
  id: String(extra.id),
  name: extra.name || '',
  category: extra.category || '',
  price: toNumber(extra.unitPrice, 0),
  boatIds: Array.isArray(extra.boat) ? extra.boat.map(toId).filter(Boolean) : [],
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
  const discount = coupon.type === 'percentage' ? subtotal * (amount / 100) : coupon.type === 'fixed' ? amount : 0
  return { discount: Math.min(subtotal, money(discount)), message: '' }
}

const calculatePrice = async ({ payload, body }: { payload: any; body: any }) => {
  const { duration, start, end } = getBookingTimes(body)
  const boatId = String(body.boatId || '').trim()
  if (!boatId) throw new Error('Yacht is required.')

  const boat = await payload.findByID({ collection: 'boats', id: boatId, depth: 1, overrideAccess: true })
  const baseHourlyPrice = toNumber(boat.salePrice, 0) > 0 ? toNumber(boat.salePrice, 0) : toNumber(boat.price, 0)
  const yachtSubtotal = money(baseHourlyPrice * duration)

  const selectedExtras = Array.isArray(body.extras) ? body.extras : []
  const extrasRows = []
  let extrasSubtotal = 0

  for (const row of selectedExtras) {
    const extraId = String(row.extraId || row.id || '').trim()
    const quantity = Math.max(1, toNumber(row.quantity, 1))
    if (!extraId) continue

    const extra = await payload.findByID({ collection: 'extras', id: extraId, depth: 0, overrideAccess: true })
    const unitPrice = toNumber(extra.unitPrice, 0)
    extrasSubtotal += unitPrice * quantity
    extrasRows.push({ extra: extraId, quantity, unitPrice, name: extra.name || '', total: unitPrice * quantity })
  }

  const otherExtrasRows = (Array.isArray(body.otherExtras) ? body.otherExtras : [])
    .map((row: any) => ({
      name: String(row.description || row.name || '').trim(),
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
        const paidOrPendingBefore = rows
          .slice(0, index + 1)
          .reduce((sum: number, item: any) => sum + money(toNumber(item.amount, 0)), 0)

        return {
          id: row.id || `desk-payment-${Date.now()}-${index}`,
          kind: row.kind || (rows.length === 1 ? 'full' : index === 0 ? 'downpayment' : 'balance'),
          createdAt: now,
          installedAt: status === 'pending' ? now : '',
          paidAt: status === 'completed' ? now : '',
          amount,
          method,
          ...getFeeFields(amount, method),
          date: row.date ? new Date(`${row.date}T12:00:00.000Z`).toISOString() : now,
          status,
          balance: Math.max(0, totalPrice - paidOrPendingBefore),
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

const mapReservation = (reservation: any) => {
  const boat = reservation.boat && typeof reservation.boat === 'object' ? reservation.boat : null
  const supplier = boat ? getSupplier(boat) : null
  const start = reservation.startTime ? new Date(reservation.startTime) : null
  const isPast = start ? start <= new Date() : false

  return {
    id: String(reservation.id),
    transactionId: reservation.transactionId || '',
    boatId: toId(reservation.boat),
    boatName: boat?.name || 'Unknown yacht',
    supplierName: supplier?.name || supplier?.title || '',
    guestName: reservation.user || '',
    guestEmail: reservation.guestEmail || '',
    guestPhone: reservation.guestPhone || '',
    countryCode: reservation.countryCode || '+971',
    guests: toNumber(reservation.guests, 0),
    status: reservation.status || 'pending',
    startTime: reservation.startTime || '',
    endTime: reservation.endTime || '',
    meetingPointName: reservation.meetingPointName || '',
    meetingPointPin: reservation.meetingPointPin || '',
    contactPersonName: reservation.contactPersonName || '',
    contactPersonNumber: reservation.contactPersonNumber || '',
    parkingLocationName: reservation.parkingLocationName || '',
    parkingLocationPin: reservation.parkingLocationPin || '',
    totalPrice: toNumber(reservation.totalPrice, 0),
    isPast,
    adminUrl: `/admin/collections/reservations/${reservation.id}`,
  }
}

const getReservationPayload = ({ body, preview }: { body: any; preview: any }) => {
  const boat = preview.boat as any
  const supplierId = toId(boat.owner)
  const locationName = getLocationName(boat.location)
  const payments = buildPayments({ body, totalPrice: preview.totalPrice })

  return {
    boat: String(boat.id),
    supplier: supplierId || undefined,
    departureLocation: locationName,
    user: String(body.guestName || '').trim(),
    guestEmail: String(body.guestEmail || '').trim(),
    countryCode: String(body.countryCode || '+971').trim(),
    guestPhone: String(body.guestPhone || '').trim(),
    guests: Math.max(1, toNumber(body.guests, 1)),
    startTime: preview.start.toISOString(),
    endTime: preview.end.toISOString(),
    status: body.status || 'pending',
    specialRequests: String(body.specialRequests || '').trim(),
    extras: preview.extrasRows.map((row: any) => ({ extra: row.extra, quantity: row.quantity, unitPrice: row.unitPrice })),
    otherExtras: preview.otherExtrasRows,
    coupon: preview.coupon?.id || undefined,
    couponCode: preview.coupon?.code || String(body.couponCode || '').trim().toUpperCase(),
    customDiscountAmount: preview.customDiscount,
    meetingPointName: String(body.meetingPointName || '').trim(),
    meetingPointPin: String(body.meetingPointPin || '').trim(),
    contactPersonName: String(body.contactPersonName || '').trim(),
    contactPersonNumber: String(body.contactPersonNumber || '').trim(),
    parkingLocationName: String(body.parkingLocationName || '').trim(),
    parkingLocationPin: String(body.parkingLocationPin || '').trim(),
    totalPrice: preview.totalPrice,
    method: normalizePaymentMethod(String(body.method || 'Mamo Pay')),
    paymentMethod: payments.length > 1 ? 'scheduled' : 'full',
    payments,
    paymentsUpdateSource: 'payment-manager',
  }
}

export const reservationDeskEndpoints: Endpoint[] = [
  {
    path: '/reservation-desk/options',
    method: 'get',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })

      const [boats, extras, coupons] = await Promise.all([
        req.payload.find({ collection: 'boats', depth: 1, limit: 500, sort: 'name', overrideAccess: true, where: { archived: { not_equals: true } } }),
        req.payload.find({ collection: 'extras', depth: 0, limit: 500, sort: 'name', overrideAccess: true, where: { archived: { not_equals: true } } }),
        req.payload.find({ collection: 'coupons', depth: 0, limit: 500, sort: 'code', overrideAccess: true }),
      ])

      return Response.json({
        boats: (boats.docs || []).map(mapBoat),
        extras: (extras.docs || []).map(mapExtra),
        coupons: (coupons.docs || []).map(mapCoupon),
      })
    },
  },
  {
    path: '/reservation-desk/bookings',
    method: 'get',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })

      const reservations = await req.payload.find({
        collection: 'reservations',
        depth: 2,
        limit: 250,
        sort: '-createdAt',
        overrideAccess: true,
      })

      return Response.json({ bookings: (reservations.docs || []).map(mapReservation) })
    },
  },
  {
    path: '/reservation-desk/status',
    method: 'patch',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })
      const body = await getRequestBody(req)
      const id = String(body.id || '').trim()
      const status = String(body.status || '').trim()

      if (!id || !['pending', 'awaiting payment', 'confirmed_balance_due', 'confirmed', 'cancelled'].includes(status)) {
        return Response.json({ message: 'Invalid reservation or status.' }, { status: 400 })
      }

      try {
        const updated = await req.payload.update({
          collection: 'reservations',
          id,
          data: { status } as any,
          overrideAccess: true,
        })

        return Response.json({ booking: mapReservation(updated) })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not update status'
        return Response.json({ message: `Could not update status: ${message}` }, { status: 400 })
      }
    },
  },
  {
    path: '/reservation-desk/:id',
    method: 'get',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })
      const routeParams = (req as any).routeParams || {}
      const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id

      const reservation = await req.payload.findByID({
        collection: 'reservations',
        id,
        depth: 2,
        overrideAccess: true,
      })

      return Response.json({ booking: mapReservation(reservation), raw: reservation })
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
      const bookedBoatIds = await getBookedBoatIds({ payload: req.payload, start, end, excludeReservationId: body.id })

      const boats = await req.payload.find({
        collection: 'boats',
        depth: 1,
        limit: 500,
        overrideAccess: true,
        sort: 'name',
        where: { archived: { not_equals: true } },
      })

      return Response.json({
        boats: (boats.docs || [])
          .filter((boat: any) => !bookedBoatIds.has(String(boat.id)))
          .filter((boat: any) => toNumber(boat.boatSpecifications?.capacity, 0) >= guests)
          .map(mapBoat),
      })
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
      const bookedBoatIds = await getBookedBoatIds({ payload: req.payload, start: preview.start, end: preview.end })

      if (bookedBoatIds.has(String(preview.boat.id))) {
        return Response.json({ message: 'This yacht is already booked for that date and time.' }, { status: 409 })
      }

      const doc = await req.payload.create({
        collection: 'reservations',
        data: getReservationPayload({ body, preview }) as any,
        overrideAccess: true,
        context: { paymentsUpdateSource: 'payment-manager', reservationDeskFinalTotal: preview.totalPrice },
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
  {
    path: '/reservation-desk/:id',
    method: 'patch',
    handler: async (req) => {
      if (!req.user) return Response.json({ message: 'Unauthorized' }, { status: 401 })
      const routeParams = (req as any).routeParams || {}
      const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id
      const existing = await req.payload.findByID({ collection: 'reservations', id, depth: 0, overrideAccess: true })

      if (existing?.startTime && new Date(existing.startTime) <= new Date()) {
        return Response.json({ message: 'Past reservations cannot be edited from Reservation Desk.' }, { status: 400 })
      }

      const body = await getRequestBody(req)
      const preview = await calculatePrice({ payload: req.payload, body })
      const bookedBoatIds = await getBookedBoatIds({ payload: req.payload, start: preview.start, end: preview.end, excludeReservationId: id })

      if (bookedBoatIds.has(String(preview.boat.id))) {
        return Response.json({ message: 'This yacht is already booked for that date and time.' }, { status: 409 })
      }

      const doc = await req.payload.update({
        collection: 'reservations',
        id,
        data: getReservationPayload({ body, preview }) as any,
        overrideAccess: true,
        context: { paymentsUpdateSource: 'payment-manager', reservationDeskFinalTotal: preview.totalPrice },
      })

      return Response.json({ success: true, reservation: mapReservation(doc) })
    },
  },
]
