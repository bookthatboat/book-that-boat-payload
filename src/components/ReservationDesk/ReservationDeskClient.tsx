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
}

type PaymentRow = {
  amount: number
  method: 'Mamo Pay' | 'Bank Transfer' | 'Cash'
  status: 'scheduled' | 'pending' | 'completed'
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

  const updateStatus = async (booking: BookingRow, status: string) => {
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

  const addPayment = () => setPayments((current) => [...current, { ...defaultPayment(0), kind: current.length ? 'balance' : 'full', method: form.method }])
  const updatePayment = (index: number, key: keyof PaymentRow, value: any) => setPayments((current) => current.map((payment, i) => (i === index ? { ...payment, [key]: value } : payment)))
  const removePayment = (index: number) => setPayments((current) => current.filter((_, i) => i !== index))

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
            {['Trip & Yacht', 'Guest', 'Extras', 'Price', 'Review'].map((label, index) => (
              <button key={label} type="button" className={step === index ? 'is-active' : ''} onClick={() => setStep(index)}>
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
                  <button type="button" onClick={() => setStep(3)}>Continue</button>
                </div>
              ) : null}

              {step === 3 ? (
                <div className="btb-reservation-desk__form">
                  <h2>Price & Discounts</h2>
                  <div className="btb-reservation-desk__total">{formatAED(preview?.totalPrice || 0)}</div>
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
                      <select value={payment.status} onChange={(event) => updatePayment(index, 'status', event.target.value)}>
                        <option value="scheduled">Scheduled</option>
                        <option value="pending">Awaiting Payment</option>
                        <option value="completed">Received</option>
                      </select>
                      <input type="date" value={payment.date} onChange={(event) => updatePayment(index, 'date', event.target.value)} />
                      <button type="button" onClick={() => removePayment(index)}>Remove</button>
                    </div>
                  ))}
                  <button type="button" onClick={addPayment}>Add payment row</button>
                  <button type="button" onClick={() => setStep(4)}>Review</button>
                </div>
              ) : null}

              {step === 4 ? (
                <div>
                  <h2>Review</h2>
                  <div className="btb-reservation-desk__review">
                    <p><strong>Yacht:</strong> {selectedBoat?.name}</p>
                    <p><strong>Supplier:</strong> {selectedBoat?.supplierName}</p>
                    <p><strong>Trip:</strong> {form.date} at {form.startTime} for {form.duration}h</p>
                    <p><strong>Guest:</strong> {form.guestName} - {form.countryCode} {form.guestPhone}</p>
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
