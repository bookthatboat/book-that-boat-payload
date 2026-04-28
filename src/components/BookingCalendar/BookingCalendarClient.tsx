'use client'

import React, { useMemo, useState } from 'react'

export type CalendarBooking = {
  id: string
  transactionId?: string
  title: string
  guestName: string
  guestEmail?: string
  guestPhone?: string
  boatId?: string
  boatName: string
  supplierId: string
  supplierName: string
  supplierPhone?: string
  startTime: string
  endTime: string
  guests?: number
  totalPrice?: number
  departureLocation?: string
  meetingPointName?: string
  contactPersonName?: string
  contactPersonNumber?: string
  parkingLocationName?: string
  adminUrl: string
}

type Props = {
  bookings: CalendarBooking[]
}

const DUBAI_TIME_ZONE = 'Asia/Dubai'

const currencyFormatter = new Intl.NumberFormat('en-AE', {
  style: 'currency',
  currency: 'AED',
  maximumFractionDigits: 0,
})

const dateKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DUBAI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const monthFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBAI_TIME_ZONE,
  month: 'long',
  year: 'numeric',
})

const dayHeadingFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBAI_TIME_ZONE,
  weekday: 'long',
  day: '2-digit',
  month: 'long',
  year: 'numeric',
})

const dateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBAI_TIME_ZONE,
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
})

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: DUBAI_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
})

const toDubaiDateKey = (value: string | Date) => dateKeyFormatter.format(new Date(value))

const getMonthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1)

const addMonths = (date: Date, months: number) => new Date(date.getFullYear(), date.getMonth() + months, 1)

const getCalendarCells = (month: Date) => {
  const firstDay = getMonthStart(month)
  const daysInMonth = new Date(firstDay.getFullYear(), firstDay.getMonth() + 1, 0).getDate()
  const mondayBasedStartOffset = (firstDay.getDay() + 6) % 7
  const cells: Array<Date | null> = []

  for (let i = 0; i < mondayBasedStartOffset; i += 1) {
    cells.push(null)
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(firstDay.getFullYear(), firstDay.getMonth(), day))
  }

  while (cells.length % 7 !== 0) {
    cells.push(null)
  }

  return cells
}

const sortByStartTime = (a: CalendarBooking, b: CalendarBooking) => {
  return new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
}

const getUniqueSuppliers = (bookings: CalendarBooking[]) => {
  const supplierMap = new Map<string, string>()

  bookings.forEach((booking) => {
    supplierMap.set(booking.supplierId || 'unassigned', booking.supplierName || 'No supplier assigned')
  })

  return Array.from(supplierMap.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const InfoLine = ({ label, value }: { label: string; value?: string | number }) => {
  if (value === undefined || value === null || value === '') return null

  return (
    <div className="btb-booking-calendar__info-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export const BookingCalendarClient = ({ bookings }: Props) => {
  const [visibleMonth, setVisibleMonth] = useState(() => getMonthStart(new Date()))
  const [selectedDateKey, setSelectedDateKey] = useState(() => toDubaiDateKey(new Date()))
  const [supplierFilter, setSupplierFilter] = useState('all')

  const suppliers = useMemo(() => getUniqueSuppliers(bookings), [bookings])

  const filteredBookings = useMemo(() => {
    return bookings
      .filter((booking) => supplierFilter === 'all' || booking.supplierId === supplierFilter)
      .sort(sortByStartTime)
  }, [bookings, supplierFilter])

  const bookingsByDate = useMemo(() => {
    const grouped = new Map<string, CalendarBooking[]>()

    filteredBookings.forEach((booking) => {
      const key = toDubaiDateKey(booking.startTime)
      const existing = grouped.get(key) || []
      grouped.set(key, [...existing, booking].sort(sortByStartTime))
    })

    return grouped
  }, [filteredBookings])

  const selectedBookings = bookingsByDate.get(selectedDateKey) || []
  const cells = getCalendarCells(visibleMonth)
  const monthTotal = cells.reduce((total, cell) => {
    if (!cell) return total
    return total + (bookingsByDate.get(toDubaiDateKey(cell))?.length || 0)
  }, 0)

  return (
    <main className="btb-booking-calendar">
      <section className="btb-booking-calendar__hero">
        <div>
          <p className="btb-booking-calendar__eyebrow">Operations</p>
          <h1>Confirmed Booking Calendar</h1>
          <p>
            Track upcoming confirmed bookings, see which supplier owns each yacht, and open the
            reservation record when you need to update details.
          </p>
        </div>

        <div className="btb-booking-calendar__stats">
          <div>
            <span>Upcoming confirmed</span>
            <strong>{filteredBookings.length}</strong>
          </div>
          <div>
            <span>This month</span>
            <strong>{monthTotal}</strong>
          </div>
        </div>
      </section>

      <section className="btb-booking-calendar__toolbar">
        <div>
          <button type="button" onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))}>
            Previous
          </button>
          <strong>{monthFormatter.format(visibleMonth)}</strong>
          <button type="button" onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}>
            Next
          </button>
        </div>

        <label>
          Supplier
          <select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}>
            <option value="all">All suppliers</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="btb-booking-calendar__grid-wrap">
        <div className="btb-booking-calendar__weekdays">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>

        <div className="btb-booking-calendar__grid">
          {cells.map((cell, index) => {
            if (!cell) {
              return <div key={`empty-${index}`} className="btb-booking-calendar__day is-empty" />
            }

            const key = toDubaiDateKey(cell)
            const dayBookings = bookingsByDate.get(key) || []
            const isSelected = selectedDateKey === key

            return (
              <button
                key={key}
                type="button"
                className={`btb-booking-calendar__day${isSelected ? ' is-selected' : ''}`}
                onClick={() => setSelectedDateKey(key)}
              >
                <span className="btb-booking-calendar__date-number">{cell.getDate()}</span>
                {dayBookings.slice(0, 3).map((booking) => (
                  <span key={booking.id} className="btb-booking-calendar__event-pill">
                    {timeFormatter.format(new Date(booking.startTime))} · {booking.boatName}
                  </span>
                ))}
                {dayBookings.length > 3 && (
                  <span className="btb-booking-calendar__more">+{dayBookings.length - 3} more</span>
                )}
              </button>
            )
          })}
        </div>
      </section>

      <section className="btb-booking-calendar__details">
        <div className="btb-booking-calendar__details-header">
          <div>
            <p className="btb-booking-calendar__eyebrow">Selected day</p>
            <h2>{dayHeadingFormatter.format(new Date(`${selectedDateKey}T12:00:00`))}</h2>
          </div>
          <span>{selectedBookings.length} booking{selectedBookings.length === 1 ? '' : 's'}</span>
        </div>

        {selectedBookings.length === 0 ? (
          <div className="btb-booking-calendar__empty">No confirmed bookings on this day.</div>
        ) : (
          <div className="btb-booking-calendar__cards">
            {selectedBookings.map((booking) => (
              <article key={booking.id} className="btb-booking-calendar__card">
                <div className="btb-booking-calendar__card-header">
                  <div>
                    <h3>{booking.boatName}</h3>
                    <p>{dateTimeFormatter.format(new Date(booking.startTime))} - {timeFormatter.format(new Date(booking.endTime))}</p>
                  </div>
                  <a href={booking.adminUrl}>Open reservation</a>
                </div>

                <div className="btb-booking-calendar__info-grid">
                  <InfoLine label="Supplier" value={booking.supplierName} />
                  <InfoLine label="Supplier phone" value={booking.supplierPhone} />
                  <InfoLine label="Guest" value={booking.guestName} />
                  <InfoLine label="Guest phone" value={booking.guestPhone} />
                  <InfoLine label="Guests" value={booking.guests} />
                  <InfoLine label="Total" value={booking.totalPrice ? currencyFormatter.format(booking.totalPrice) : ''} />
                  <InfoLine label="Meeting point" value={booking.meetingPointName || booking.departureLocation} />
                  <InfoLine label="Contact person" value={booking.contactPersonName} />
                  <InfoLine label="Contact number" value={booking.contactPersonNumber} />
                  <InfoLine label="Parking" value={booking.parkingLocationName} />
                  <InfoLine label="Booking ID" value={booking.transactionId || booking.id} />
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="btb-booking-calendar__upcoming">
        <div className="btb-booking-calendar__details-header">
          <div>
            <p className="btb-booking-calendar__eyebrow">Overview</p>
            <h2>Next confirmed bookings</h2>
          </div>
        </div>

        <div className="btb-booking-calendar__table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date / Time</th>
                <th>Boat</th>
                <th>Supplier</th>
                <th>Guest</th>
                <th>Guests</th>
                <th>Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filteredBookings.slice(0, 30).map((booking) => (
                <tr key={booking.id}>
                  <td>{dateTimeFormatter.format(new Date(booking.startTime))}</td>
                  <td>{booking.boatName}</td>
                  <td>{booking.supplierName}</td>
                  <td>{booking.guestName}</td>
                  <td>{booking.guests || '-'}</td>
                  <td>{booking.totalPrice ? currencyFormatter.format(booking.totalPrice) : '-'}</td>
                  <td><a href={booking.adminUrl}>Open</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
