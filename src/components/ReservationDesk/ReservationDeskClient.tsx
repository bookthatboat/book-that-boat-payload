'use client'

import React, { useEffect, useMemo, useState } from 'react'

type BoatOption = {
  id: string
  name: string
  image?: string
  price: number
  capacity: number
  harbour?: string
  supplierName?: string
  extraIds?: string[]
}

type ExtraOption = {
  id: string
  name: string
  category: string
  price: number
  boatIds?: string[]
}

type CouponOption = {
  id: string
  code: string
}

type BookingRow = {
  id: string
  transactionId?: string
  boatId?: string
  boatName: string
  guestName: string
  guestEmail?: string
  guestPhone?: string
  countryCode?: string
  guests?: number
  status: string
  startTime: string
  endTime: string
  totalPrice: number
  isPast: boolean
  adminUrl: string
  specialRequests?: string
  meetingPointName?: string
  meetingPointPin?: string
  contactPersonName?: string
  contactPersonNumber?: string
  parkingLocationName?: string
  parkingLocationPin?: string
}

type PaymentRow = {
  amount: number
  method: 'Mamo Pay' | 'Bank Transfer' | 'Cash'
  status: 'scheduled'
  date: string
  kind: 'full' | 'downpayment' | 'installment' | 'balance'
}

const today = new Date().toISOString().slice(0, 10)

const DURATION_OPTIONS = Array.from({ length: 31 }, (_, index) => {
  const value = 1 + index * 0.5
  const hours = Math.floor(value)
  const minutes = value % 1 === 0 ? '' : ' 30m'
  return { value, label: `${hours}h${minutes}` }
})

const formatAED = (value: number) =>
  Number(value || 0).toLocaleString('en-AE', {
    style: 'currency',
    currency: 'AED',
    maximumFractionDigits: 0,
  })

const toDateInput = (date = new Date()) => date.toISOString().slice(0, 10)

const toDubaiDateInput = (value?: string) => {
  if (!value) return today
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return today
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' })
}

const toDubaiTimeInput = (value?: string) => {
  if (!value) return '17:00'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '17:00'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

const durationFromTimes = (start?: string, end?: string) => {
  if (!start || !end) return 3
  const diff = (new Date(end).getTime() - new Date(start).getTime()) / (1000 * 60 * 60)
  return Number.isFinite(diff) && diff > 0 ? Math.round(diff * 2) / 2 : 3
}

const defaultPayment = (amount = 0): PaymentRow => ({
  amount: Math.max(0, Math.round(amount)),
  method: 'Mamo Pay',
  status: 'scheduled',
  date: toDateInput(),
  kind: 'full',
})

const emptyForm = {
  date: today,
  startTime: '17:00',
  duration: 3,
  guests: 10,
  yachtSearch: '',
  boatId: '',
  guestName: '',
  guestEmail: '',
  countryCode: '+971',
  guestPhone: '',
  specialRequests: '',
  meetingPointName: '',
  meetingPointPin: '',
  contactPersonName: '',
  contactPersonNumber: '',
  parkingLocationName: '',
  parkingLocationPin: '',
  couponId: '',
  couponCode: '',
  customDiscountAmount: 0,
  status: 'pending',
  method: 'Mamo Pay' as 'Mamo Pay' | 'Bank Transfer' | 'Cash',
}

const isEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

export default function ReservationDeskClient() {
  const [view, setView] = useState<'list' | 'form'>('list')
  const [step, setStep] = useState(0)
  const [editingId, setEditingId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [bookings, setBookings] = useState<BookingRow[]>([])
  const [boats, setBoats] = useState<BoatOption[]>([])
  const [extras, setExtras] = useState<ExtraOption[]>([])
  const [coupons, setCoupons] = useState<CouponOption[]>([])
  const [preview, setPreview] = useState<any>(null)
  const [created, setCreated] = useState<any>(null)
  const [form, setForm] = useState(emptyForm)
  const [selectedExtras, setSelectedExtras] = useState<Record<string, number>>({})
  const [extraCategory, setExtraCategory] = useState('all')
  const [otherExtras, setOtherExtras] = useState<Array<{ description: string; price: number; quantity: number }>>([])
  const [payments, setPayments] = useState<PaymentRow[]>([defaultPayment(0)])
  const [paymentMode, setPaymentMode] = useState<'full' | 'multiple'>('full')
  const [paymentCount, setPaymentCount] = useState(2)

  const selectedBoat = boats.find((boat) => boat.id === form.boatId) || null

  const filteredBoats = useMemo(() => {
    const query = form.yachtSearch.trim().toLowerCase()
    if (!query) return []
    return boats.filter((boat) => boat.name.toLowerCase().includes(query)).slice(0, 8)
  }, [boats, form.yachtSearch])

  const availableExtras = useMemo(() => {
    if (!selectedBoat) return []
    return extras.filter((extra) => {
      const linkedByBoat = selectedBoat.extraIds?.includes(extra.id)
      const linkedByExtra = extra.boatIds?.includes(selectedBoat.id)
      const categoryMatch = extraCategory === 'all' || extra.category === extraCategory
      return categoryMatch && (linkedByBoat || linkedByExtra)
    })
  }, [extras, extraCategory, selectedBoat])

  const categories = useMemo(() => Array.from(new Set(extras.map((extra) => extra.category).filter(Boolean))).sort(), [extras])

  const selectedExtraRows = useMemo(
    () =>
      Object.entries(selectedExtras)
        .filter(([, quantity]) => quantity > 0)
        .map(([extraId, quantity]) => ({ extraId, quantity })),
    [selectedExtras],
  )

  const update = (key: keyof typeof form, value: any) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const resetForm = () => {
    setEditingId('')
    setCreated(null)
    setPreview(null)
    setForm(emptyForm)
    setSelectedExtras({})
    setOtherExtras([])
    setPayments([defaultPayment(0)])
    setPaymentMode('full')
    setPaymentCount(2)
    setStep(0)
    setView('form')
  }

  const loadOptions = async () => {
    const response = await fetch('/api/reservation-desk/options', { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.message || 'Could not load options.')
    setBoats(data.boats || [])
    setExtras(data.extras || [])
    setCoupons(data.coupons || [])
  }

  const loadBookings = async () => {
    const response = await fetch('/api/reservation-desk/bookings', { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.message || 'Could not load bookings.')
    setBookings(data.bookings || [])
  }

  const loadPreview = async () => {
    if (!form.boatId) return

    const response = await fetch('/api/reservation-desk/price-preview', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, extras: selectedExtraRows, otherExtras }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.message || 'Could not calculate price.')
    setPreview(data.preview)

    if (!payments.some((payment) => payment.amount > 0)) {
      setPayments([defaultPayment(data.preview.totalPrice || 0)])
    }
  }


  const hydratePaymentsFromTotal = (
    total: number,
    mode = paymentMode,
    count = paymentCount,
    method = form.method,
  ) => {
    const safeTotal = Math.max(0, Math.round(Number(total || 0)))

    if (mode === 'full') {
      setPayments([
        {
          amount: safeTotal,
          method,
          status: 'scheduled',
          date: toDateInput(),
          kind: 'full',
        },
      ])
      return
    }

    const safeCount = Math.max(2, Math.min(10, Math.floor(Number(count || 2))))
    const base = Math.floor(safeTotal / safeCount)
    const remainder = safeTotal - base * safeCount

    setPayments(
      Array.from({ length: safeCount }, (_, index) => ({
        amount: base + (index === 0 ? remainder : 0),
        method,
        status: 'scheduled' as const,
        date: toDateInput(),
        kind: index === 0 ? 'downpayment' : index === safeCount - 1 ? 'balance' : 'installment',
      })),
    )
  }

  const applyPaymentMode = (mode: 'full' | 'multiple', count = paymentCount) => {
    setPaymentMode(mode)
    const safeCount = Math.max(2, Math.min(10, Math.floor(Number(count || 2))))
    setPaymentCount(safeCount)
    hydratePaymentsFromTotal(preview?.totalPrice || 0, mode, safeCount, form.method)
  }

  const canAccessStep = (targetStep: number) => {
    if (targetStep <= step) return true
    if (targetStep >= 1 && (!form.date || !form.startTime || !form.duration || !form.guests || !form.boatId)) return false
    if (targetStep >= 2 && (!form.guestName || !form.guestEmail || !form.countryCode || !form.guestPhone || !isEmail(form.guestEmail))) return false
    if (targetStep >= 3 && (!form.meetingPointName || !form.meetingPointPin || !form.contactPersonName || !form.contactPersonNumber || !form.parkingLocationName || !form.parkingLocationPin)) return false
    return true
  }

  const updateStatus = async (booking: BookingRow, status: string) => {
    if (status === booking.status) return

    const confirmed = window.confirm(
      `Are you sure you want to change booking ${booking.transactionId || booking.id} from "${booking.status}" to "${status}"?`,
    )

    if (!confirmed) return

    setError('')
    const response = await fetch('/api/reservation-desk/status', {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: booking.id, status }),
    })
    const data = await response.json()
    if (!response.ok) {
      setError(data?.message || 'Could not update status.')
      return
    }
    setBookings((current) => current.map((item) => (item.id === booking.id ? data.booking : item)))
  }

  const editBooking = async (booking: BookingRow) => {
    if (booking.isPast) return

    resetForm()
    setEditingId(booking.id)
    setForm((current) => ({
      ...current,
      date: toDubaiDateInput(booking.startTime),
      startTime: toDubaiTimeInput(booking.startTime),
      duration: durationFromTimes(booking.startTime, booking.endTime),
      guests: booking.guests || 1,
      boatId: booking.boatId || '',
      yachtSearch: booking.boatName || '',
      guestName: booking.guestName || '',
      guestEmail: booking.guestEmail || '',
      countryCode: booking.countryCode || '+971',
      guestPhone: booking.guestPhone || '',
      specialRequests: booking.specialRequests || '',
      meetingPointName: booking.meetingPointName || '',
      meetingPointPin: booking.meetingPointPin || '',
      contactPersonName: booking.contactPersonName || '',
      contactPersonNumber: booking.contactPersonNumber || '',
      parkingLocationName: booking.parkingLocationName || '',
      parkingLocationPin: booking.parkingLocationPin || '',
      status: booking.status || 'pending',
    }))
    setView('form')
  }

  const validateStep = (targetStep: number) => {
    setError('')

    if (step === 0) {
      if (!form.date || !form.startTime || !form.duration || !form.guests || !form.boatId) {
        setError('Date, start time, duration, guests and yacht are required.')
        return
      }
    }

    if (step === 1) {
      if (!form.guestName || !form.guestEmail || !form.countryCode || !form.guestPhone) {
        setError('Guest name, email, country code and phone are required.')
        return
      }
      if (!isEmail(form.guestEmail)) {
        setError('Enter a valid email address.')
        return
      }
    }

    if (step === 2) {
      if (!form.meetingPointName || !form.meetingPointPin || !form.contactPersonName || !form.contactPersonNumber || !form.parkingLocationName || !form.parkingLocationPin) {
        setError('Please complete the operations details before continuing.')
        return
      }
    }

    setStep(targetStep)
  }

  const saveReservation = async () => {
    setLoading(true)
    setError('')
    setMessage('')

    try {
      const response = await fetch(editingId ? `/api/reservation-desk/${editingId}` : '/api/reservation-desk/create', {
        method: editingId ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, extras: selectedExtraRows, otherExtras, payments }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data?.message || 'Could not save reservation.')
      setCreated(data.reservation)
      setMessage(editingId ? 'Reservation updated.' : 'Reservation created.')
      await loadBookings()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save reservation.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    Promise.all([loadOptions(), loadBookings()]).catch((err) => setError(err instanceof Error ? err.message : 'Could not load Reservation Desk.'))
  }, [])

  useEffect(() => {
    if (!form.boatId) return
    loadPreview().catch((err) => setError(err instanceof Error ? err.message : 'Could not calculate price.'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.boatId, form.duration, form.couponId, form.couponCode, form.customDiscountAmount, selectedExtras, otherExtras])

  const updatePayment = (index: number, key: keyof PaymentRow, value: any) =>
    setPayments((current) =>
      current.map((payment, i) => (i === index ? { ...payment, [key]: value } : payment)),
    )

  return (
    <main className="btb-reservation-desk">
      <section className="btb-reservation-desk__hero">
        <div>
          <p>Operations</p>
          <h1>Reservation Desk</h1>
          <span>Manage bookings and create mobile-friendly reservations.</span>
        </div>
        <div className="btb-reservation-desk__hero-actions">
          <a href="/admin">Back to Admin</a>
          <a href="/admin/booking-calendar">Calendar</a>
          <button type="button" onClick={resetForm}>Create New Reservation</button>
        </div>
      </section>

      {error ? <div className="btb-reservation-desk__alert is-error">{error}</div> : null}
      {message ? <div className="btb-reservation-desk__alert is-success">{message}</div> : null}

      {created && view === 'form' ? (
        <div className="btb-reservation-desk__alert is-success">
          <strong>Reservation saved.</strong>
          <button
            type="button"
            onClick={() => {
              setCreated(null)
              setView('list')
              setStep(0)
            }}
          >
            Back to Reservation Desk
          </button>
        </div>
      ) : null}

      {view === 'list' ? (
        <section className="btb-reservation-desk__panel">
          <h2>Bookings</h2>
          <div className="btb-reservation-desk__bookings">
            {bookings.map((booking) => (
              <article key={booking.id}>
                <div>
                  <strong>{booking.transactionId || booking.id}</strong>
                  <span>{booking.boatName} - {booking.guestName}</span>
                  <small>{new Date(booking.startTime).toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} - {formatAED(booking.totalPrice)}</small>
                </div>
                <select value={booking.status} onChange={(event) => updateStatus(booking, event.target.value)}>
                  <option value="pending">Pending</option>
                  <option value="awaiting payment">Awaiting Payment</option>
                  <option value="confirmed_balance_due">Confirmed - Balance Due</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="cancelled">Cancelled</option>
                </select>
                <button type="button" disabled={booking.isPast} onClick={() => editBooking(booking)}>
                  {booking.isPast ? 'Past trip' : 'Edit'}
                </button>
                <a href={booking.adminUrl}>Advanced</a>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <>
          <nav className="btb-reservation-desk__steps">
            {['Trip & Yacht', 'Guest', 'Operations', 'Extras', 'Price', 'Review'].map((label, index) => (
              <button
                key={label}
                type="button"
                className={step === index ? 'is-active' : ''}
                disabled={!canAccessStep(index)}
                onClick={() => {
                  if (canAccessStep(index)) setStep(index)
                }}
              >
                {index + 1}. {label}
              </button>
            ))}
          </nav>

          <div className="btb-reservation-desk__layout">
            <section className="btb-reservation-desk__panel">
              {step === 0 ? (
                <div className="btb-reservation-desk__form">
                  <h2>Trip & Yacht</h2>
                  <label>Date<input required type="date" min={today} value={form.date} onChange={(event) => update('date', event.target.value)} /></label>
                  <label>Start time<input required type="time" value={form.startTime} onChange={(event) => update('startTime', event.target.value)} /></label>
                  <label>Duration
                    <select required value={form.duration} onChange={(event) => update('duration', Number(event.target.value))}>
                      {DURATION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                  <label>Guests<input required type="number" min={1} value={form.guests} onChange={(event) => update('guests', Number(event.target.value))} /></label>
                  <label>Yacht
                    <input required value={form.yachtSearch} onChange={(event) => {
                      update('yachtSearch', event.target.value)
                      update('boatId', '')
                    }} placeholder="Type yacht name" />
                  </label>
                  {filteredBoats.length ? (
                    <div className="btb-reservation-desk__yacht-results">
                      {filteredBoats.map((boat) => (
                        <button key={boat.id} type="button" onClick={() => {
                          update('boatId', boat.id)
                          update('yachtSearch', boat.name)
                        }}>
                          <strong>{boat.name}</strong>
                          <span>{boat.harbour || 'Dubai'} - {boat.capacity} guests - {formatAED(boat.price)}/h</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <label>Supplier<input readOnly value={selectedBoat?.supplierName || ''} placeholder="Select yacht first" /></label>
                  <button type="button" onClick={() => validateStep(1)}>Continue</button>
                </div>
              ) : null}

              {step === 1 ? (
                <div className="btb-reservation-desk__form">
                  <h2>Guest</h2>
                  <label>Guest name<input required value={form.guestName} onChange={(event) => update('guestName', event.target.value)} /></label>
                  <label>Email<input required type="email" value={form.guestEmail} onChange={(event) => update('guestEmail', event.target.value)} /></label>
                  <label>Country code<input required value={form.countryCode} onChange={(event) => update('countryCode', event.target.value)} /></label>
                  <label>Phone<input required value={form.guestPhone} onChange={(event) => update('guestPhone', event.target.value)} /></label>
                  <label>Special requests<textarea value={form.specialRequests} onChange={(event) => update('specialRequests', event.target.value)} /></label>
                  <button type="button" onClick={() => validateStep(2)}>Continue</button>
                </div>
              ) : null}

              {step === 2 ? (
                <div>
                  <h2>Operations</h2>
                  <div className="reservation-desk__grid">
                    <label>Meeting point name *<input required value={form.meetingPointName} onChange={(event) => update('meetingPointName', event.target.value)} placeholder="Dubai Harbour Gate P1" /></label>
                    <label>Meeting point pin *<input required value={form.meetingPointPin} onChange={(event) => update('meetingPointPin', event.target.value)} placeholder="Google Maps pin or URL" /></label>
                    <label>Contact person name *<input required value={form.contactPersonName} onChange={(event) => update('contactPersonName', event.target.value)} placeholder="Captain or coordinator name" /></label>
                    <label>Contact person number *<input required value={form.contactPersonNumber} onChange={(event) => update('contactPersonNumber', event.target.value)} placeholder="+971..." /></label>
                    <label>Car parking location *<input required value={form.parkingLocationName} onChange={(event) => update('parkingLocationName', event.target.value)} placeholder="Visitor parking or valet point" /></label>
                    <label>Car parking pin *<input required value={form.parkingLocationPin} onChange={(event) => update('parkingLocationPin', event.target.value)} placeholder="Google Maps pin or URL" /></label>
                  </div>
                  <button type="button" onClick={() => setStep(1)}>Back</button>
                  <button type="button" onClick={() => validateStep(3)}>Continue</button>
                </div>
              ) : null}

              {step === 3 ? (
                <div>
                  <h2>Extras</h2>
                  <label className="btb-reservation-desk__filter">Filter by type
                    <select value={extraCategory} onChange={(event) => setExtraCategory(event.target.value)}>
                      <option value="all">All</option>
                      {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                    </select>
                  </label>

                  <div className="btb-reservation-desk__extras">
                    {availableExtras.map((extra) => (
                      <div key={extra.id}>
                        <strong>{extra.name}</strong>
                        <span>{extra.category} - {formatAED(extra.price)}</span>
                        <input type="number" min={0} value={selectedExtras[extra.id] || 0} onChange={(event) => setSelectedExtras((current) => ({ ...current, [extra.id]: Math.max(0, Number(event.target.value)) }))} />
                      </div>
                    ))}
                  </div>

                  <h3>Custom extras</h3>
                  {otherExtras.map((row, index) => (
                    <div className="btb-reservation-desk__inline" key={index}>
                      <input placeholder="Description" value={row.description} onChange={(event) => setOtherExtras((current) => current.map((item, i) => i === index ? { ...item, description: event.target.value } : item))} />
                      <input type="number" placeholder="Qty" value={row.quantity} onChange={(event) => setOtherExtras((current) => current.map((item, i) => i === index ? { ...item, quantity: Number(event.target.value) } : item))} />
                      <input type="number" placeholder="Price" value={row.price} onChange={(event) => setOtherExtras((current) => current.map((item, i) => i === index ? { ...item, price: Number(event.target.value) } : item))} />
                      <button type="button" onClick={() => setOtherExtras((current) => current.filter((_, i) => i !== index))}>Remove</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setOtherExtras((current) => [...current, { description: '', quantity: 1, price: 0 }])}>Add custom extra</button>
                  <button type="button" onClick={() => validateStep(4)}>Continue</button>
                </div>
              ) : null}

              {step === 4 ? (
                <div className="btb-reservation-desk__form">
                  <h2>Price & Discounts</h2>

                  <div className="btb-reservation-desk__total">
                    <span>Total after extras, coupon and discount</span>
                    <strong>{formatAED(preview?.totalPrice || 0)}</strong>
                  </div>

                  <label>Coupon
                    <select value={form.couponId} onChange={(event) => {
                      update('couponId', event.target.value)
                      update('couponCode', '')
                    }}>
                      <option value="">No coupon</option>
                      {coupons.map((coupon) => <option key={coupon.id} value={coupon.id}>{coupon.code}</option>)}
                    </select>
                  </label>

                  <label>Coupon code<input value={form.couponCode} onChange={(event) => {
                    update('couponCode', event.target.value)
                    update('couponId', '')
                  }} /></label>

                  <label>Custom discount<input type="number" min={0} value={form.customDiscountAmount} onChange={(event) => update('customDiscountAmount', Number(event.target.value))} /></label>

                  <div className="btb-reservation-desk__choice">
                    <button
                      type="button"
                      className={paymentMode === 'full' ? 'is-active' : ''}
                      onClick={() => applyPaymentMode('full')}
                    >
                      Pay in full
                    </button>
                    <button
                      type="button"
                      className={paymentMode === 'multiple' ? 'is-active' : ''}
                      onClick={() => applyPaymentMode('multiple')}
                    >
                      Multiple payments
                    </button>
                  </div>

                  {paymentMode === 'multiple' ? (
                    <label>Number of payments
                      <select value={paymentCount} onChange={(event) => applyPaymentMode('multiple', Number(event.target.value))}>
                        {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((count) => (
                          <option key={count} value={count}>{count} payments</option>
                        ))}
                      </select>
                    </label>
                  ) : null}

                  {payments.map((payment, index) => (
                    <div className="btb-reservation-desk__payment" key={index}>
                      <input type="number" value={payment.amount} onChange={(event) => updatePayment(index, 'amount', Number(event.target.value))} />
                      <select value={payment.kind} onChange={(event) => updatePayment(index, 'kind', event.target.value)}>
                        <option value="full">Full</option>
                        <option value="downpayment">Down payment</option>
                        <option value="installment">Installment</option>
                        <option value="balance">Balance</option>
                      </select>
                      <select value={payment.method} onChange={(event) => updatePayment(index, 'method', event.target.value)}>
                        <option value="Mamo Pay">Mamo Pay</option>
                        <option value="Bank Transfer">Bank Transfer</option>
                        <option value="Cash">Cash</option>
                      </select>
                      <input type="date" value={payment.date} onChange={(event) => updatePayment(index, 'date', event.target.value)} />
                    </div>
                  ))}

                  <button type="button" onClick={() => validateStep(5)}>Review</button>
                </div>
              ) : null}

              {step === 5 ? (
                <div>
                  <h2>Review</h2>
                  <div className="btb-reservation-desk__review">
                    <p><strong>Yacht:</strong> {selectedBoat?.name}</p>
                    <p><strong>Supplier:</strong> {selectedBoat?.supplierName}</p>
                    <p><strong>Trip:</strong> {form.date} at {form.startTime} for {form.duration}h</p>
                    <p><strong>Guest:</strong> {form.guestName} - {form.countryCode} {form.guestPhone}</p>
                    <p><strong>Meeting point:</strong> {form.meetingPointName}</p>
                    <p><strong>Parking:</strong> {form.parkingLocationName}</p>
                    <p><strong>Operations contact:</strong> {form.contactPersonName} - {form.contactPersonNumber}</p>
                    <p><strong>Email:</strong> {form.guestEmail}</p>
                    <p><strong>Total:</strong> {formatAED(preview?.totalPrice || 0)}</p>
                  </div>
                  {created ? (
                    <div className="btb-reservation-desk__created">
                      <strong>{editingId ? 'Reservation updated' : 'Reservation created'}</strong>
                      <span>{created.transactionId || created.id}</span>
                      <a href={created.adminUrl || `/admin/collections/reservations/${created.id}`}>Open full reservation</a>
                    </div>
                  ) : (
                    <button type="button" disabled={loading} onClick={saveReservation}>
                      {loading ? 'Saving...' : editingId ? 'Save changes' : 'Create booking'}
                    </button>
                  )}
                </div>
              ) : null}
            </section>

            <aside className="btb-reservation-desk__summary">
              <h2>Summary</h2>
              <dl>
                <dt>Yacht</dt><dd>{selectedBoat?.name || 'Not selected'}</dd>
                <dt>Supplier</dt><dd>{selectedBoat?.supplierName || 'Not selected'}</dd>
                <dt>Trip</dt><dd>{form.date} at {form.startTime} for {form.duration}h</dd>
                <dt>Guest</dt><dd>{form.guestName || 'Not entered'}</dd>
                <dt>Subtotal</dt><dd>{formatAED(preview?.subtotalBeforeDiscount || 0)}</dd>
                <dt>Coupon discount</dt><dd>{formatAED(preview?.couponDiscount || 0)}</dd>
                <dt>Custom discount</dt><dd>{formatAED(preview?.customDiscount || 0)}</dd>
                <dt>Total</dt><dd><strong>{formatAED(preview?.totalPrice || 0)}</strong></dd>
              </dl>
              {preview?.couponMessage ? <p className="btb-reservation-desk__warning">{preview.couponMessage}</p> : null}
            </aside>
          </div>
        </>
      )}
    </main>
  )
}
