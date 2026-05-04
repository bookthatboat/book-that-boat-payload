import configPromise from '@payload-config'
import { headers as getHeaders } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import { BookingCalendarClient, type CalendarBooking } from '@/components/BookingCalendar/BookingCalendarClient'

export const dynamic = 'force-dynamic'

type RelatedDoc = {
  id?: string
  name?: string
  title?: string
  email?: string
  contactNumber?: string
  countryCode?: string
  owner?: RelatedDoc | string | null
}

const toPlainId = (value: unknown): string => {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && 'id' in value && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id
  }
  return ''
}

const getRelatedName = (value: unknown, fallback = 'Not assigned') => {
  if (!value) return fallback
  if (typeof value === 'string') return value
  const doc = value as RelatedDoc
  return doc.name || doc.title || doc.email || doc.id || fallback
}

const getBoat = (reservation: any): RelatedDoc | null => {
  return reservation?.boat && typeof reservation.boat === 'object' ? reservation.boat : null
}

const getSupplier = (reservation: any): RelatedDoc | null => {
  const boat = getBoat(reservation)
  return boat?.owner && typeof boat.owner === 'object' ? boat.owner : null
}

const mapReservationToCalendarBooking = (reservation: any): CalendarBooking => {
  const boat = getBoat(reservation)
  const supplier = getSupplier(reservation)

  return {
    id: String(reservation.id),
    transactionId: reservation.transactionId || '',
    title: `${getRelatedName(boat, 'Unknown boat')} - ${reservation.user || reservation.guestName || 'Guest'}`,
    guestName: reservation.user || reservation.guestName || 'Guest',
    guestEmail: reservation.guestEmail || '',
    guestPhone: `${reservation.countryCode || ''}${reservation.guestPhone || ''}`.trim(),
    boatId: toPlainId(reservation.boat),
    boatName: getRelatedName(boat, 'Unknown boat'),
    supplierId: supplier?.id || 'unassigned',
    supplierName: getRelatedName(supplier, 'No supplier assigned'),
    supplierPhone: `${supplier?.countryCode || ''}${supplier?.contactNumber || ''}`.trim(),
    startTime: reservation.startTime,
    endTime: reservation.endTime,
    guests: reservation.guests || 0,
    totalPrice: typeof reservation.totalPrice === 'number' ? reservation.totalPrice : Number(reservation.totalPrice || 0),
    departureLocation: reservation.departureLocation || '',
    meetingPointName: reservation.meetingPointName || '',
    contactPersonName: reservation.contactPersonName || '',
    contactPersonNumber: reservation.contactPersonNumber || '',
    parkingLocationName: reservation.parkingLocationName || '',
    adminUrl: `/admin/collections/reservations/${reservation.id}`,
  }
}

const BookingCalendarPage = async () => {
  const payload = await getPayload({ config: configPromise })
  const requestHeaders = await getHeaders()
  const authResult = await payload.auth({ headers: requestHeaders })

  if (!authResult.user) {
    redirect('/admin/login?redirect=/admin/booking-calendar')
  }

  const now = new Date()
  now.setHours(0, 0, 0, 0)

  const reservations = await payload.find({
    collection: 'reservations',
    depth: 2,
    limit: 500,
    sort: 'startTime',
    where: {
      and: [
        {
          status: {
            in: ['confirmed', 'confirmed_balance_due'],
          },
        },
        {
          startTime: {
            greater_than_equal: now.toISOString(),
          },
        },
      ],
    },
  })

  const bookings = reservations.docs.map(mapReservationToCalendarBooking)

  return <BookingCalendarClient bookings={bookings} />
}

export default BookingCalendarPage
