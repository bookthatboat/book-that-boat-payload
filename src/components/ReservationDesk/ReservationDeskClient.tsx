'use client'

import React, { useEffect, useMemo, useState } from 'react'

type BoatOption = {
  id: string
  name: string
  image?: string
  price: number
  minHours: number
  capacity: number
  length?: string
  type?: string
  harbour?: string
  supplierName?: string
}

type ExtraOption = {
  id: string
  name: string
  category: string
  price: number
}

type CouponOption = {
  id: string
  code: string
  type: string
  amount: number
  isActive: boolean
}

type PaymentRow = {
  amount: number
  method: 'Mamo Pay' | 'Bank Transfer' | 'Cash'
  status: 'scheduled' | 'pending' | 'completed'
  date: string
  kind: 'full' | 'downpayment' | 'installment' | 'balance'
}

const today = new Date().toISOString().slice(0, 10)

const toMoney = (value: number) =>
  Number(value || 0).toLocaleString('en-AE', {
    style: 'currency',
    currency: 'AED',
    maximumFractionDigits: 0,
  })

const toDateInput = (date = new Date()) => date.toISOString().slice(0, 10)

const createDefaultPayment = (amount: number): PaymentRow => ({
  amount: Math.max(0, Math.round(amount || 0)),
  method: 'Mamo Pay',
  status: 'scheduled',
  date: toDateInput(),
  kind: 'full',
})

export default function ReservationDeskClient() {
  const [step, setStep] = useState(0)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [boats, setBoats] = useState<BoatOption[]>([])
  const [extras, setExtras] = useState<ExtraOption[]>([])
  const [coupons, setCoupons] = useState<CouponOption[]>([])
  const [created, setCreated] = useState<any>(null)
  const [preview, setPreview] = useState<any>(null)
  const [form, setForm] = useState({
    date: today,
    startTime: '17:00',
    duration: 3,
    guests: 10,
    harbour: '',
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
  })
  const [selectedExtras, setSelectedExtras] = useState<Record<string, number>>({})
  const [otherExtras, setOtherExtras] = useState<Array<{ name: string; price: number; quantity: number }>>([])
  const [payments, setPayments] = useState<PaymentRow[]>([createDefaultPayment(0)])

  const selectedBoat = boats.find((boat) => boat.id === form.boatId) || null

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

  const loadOptions = async () => {
    const response = await fetch('/api/reservation-desk/options', { credentials: 'include' })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.message || 'Could not load options.')
    setExtras(data.extras || [])
    setCoupons(data.coupons || [])
  }

  const searchBoats = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/reservation-desk/available-boats', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.message || 'Could not load yachts.')
      setBoats(data.boats || [])
      setStep(1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load yachts.')
    } finally {
      setLoading(false)
    }
  }

  const loadPreview = async () => {
    if (!form.boatId) return

    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/reservation-desk/price-preview', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          extras: selectedExtraRows,
          otherExtras,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data?.message || 'Could not calculate price.')
      setPreview(data.preview)
      if (!payments.some((payment) => payment.amount > 0)) {
        setPayments([createDefaultPayment(data.preview.totalPrice || 0)])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not calculate price.')
    } finally {
      setLoading(false)
    }
  }

  const createReservation = async () => {
    setLoading(true)
    setError('')
    setMessage('')

    try {
      const response = await fetch('/api/reservation-desk/create', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          extras: selectedExtraRows,
          otherExtras,
          payments,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.success) throw new Error(data?.message || 'Could not create reservation.')
      setCreated(data.reservation)
      setMessage('Reservation created.')
      setStep(5)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create reservation.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadOptions().catch((err) => setError(err instanceof Error ? err.message : 'Could not load options.'))
  }, [])

  useEffect(() => {
    if (form.boatId) {
      loadPreview()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.boatId, form.duration, form.couponId, form.couponCode, form.customDiscountAmount, selectedExtras, otherExtras])

  const addPayment = () => {
    setPayments((current) => [
      ...current,
      {
        amount: 0,
        method: form.method,
        status: 'scheduled',
        date: toDateInput(),
        kind: current.length === 0 ? 'full' : 'balance',
      },
    ])
  }

  const updatePayment = (index: number, key: keyof PaymentRow, value: any) => {
    setPayments((current) =>
      current.map((payment, paymentIndex) =>
        paymentIndex === index ? { ...payment, [key]: value } : payment,
      ),
    )
  }

  const removePayment = (index: number) => {
    setPayments((current) => current.filter((_, paymentIndex) => paymentIndex !== index))
  }

  return (
    <main className="btb-reservation-desk">
      <section className="btb-reservation-desk__hero">
        <div>
          <p>Operations</p>
          <h1>Reservation Desk</h1>
          <span>Fast mobile booking flow for phone and WhatsApp reservations.</span>
        </div>
        <a href="/admin/booking-calendar">Open calendar</a>
      </section>

      <nav className="btb-reservation-desk__steps">
        {['Trip', 'Yacht', 'Guest', 'Extras', 'Payment', 'Review'].map((label, index) => (
          <button
            key={label}
            type="button"
            className={step === index ? 'is-active' : ''}
            onClick={() => setStep(index)}
          >
            {index + 1}. {label}
          </button>
        ))}
      </nav>

      {error ? <div className="btb-reservation-desk__alert is-error">{error}</div> : null}
      {message ? <div className="btb-reservation-desk__alert is-success">{message}</div> : null}

      <div className="btb-reservation-desk__layout">
        <section className="btb-reservation-desk__panel">
          {step === 0 ? (
            <div className="btb-reservation-desk__form">
              <h2>Trip details</h2>
              <label>Date<input type="date" min={today} value={form.date} onChange={(e) => update('date', e.target.value)} /></label>
              <label>Start time<input type="time" value={form.startTime} onChange={(e) => update('startTime', e.target.value)} /></label>
              <label>Duration in hours<input type="number" min={1} value={form.duration} onChange={(e) => update('duration', Number(e.target.value))} /></label>
              <label>Guests<input type="number" min={1} value={form.guests} onChange={(e) => update('guests', Number(e.target.value))} /></label>
              <label>Preferred harbour<input value={form.harbour} onChange={(e) => update('harbour', e.target.value)} placeholder="Optional" /></label>
              <button type="button" onClick={searchBoats} disabled={loading}>{loading ? 'Searching...' : 'Find available yachts'}</button>
            </div>
          ) : null}

          {step === 1 ? (
            <div>
              <h2>Choose yacht</h2>
              <div className="btb-reservation-desk__boat-grid">
                {boats.map((boat) => (
                  <button
                    key={boat.id}
                    type="button"
                    className={form.boatId === boat.id ? 'is-selected' : ''}
                    onClick={() => {
                      update('boatId', boat.id)
                      setStep(2)
                    }}
                  >
                    {boat.image ? <img src={boat.image} alt="" /> : null}
                    <strong>{boat.name}</strong>
                    <span>{boat.harbour || 'Dubai'} - {boat.capacity} guests - {toMoney(boat.price)}/h</span>
                    <small>{boat.supplierName || 'No supplier assigned'}</small>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="btb-reservation-desk__form">
              <h2>Guest details</h2>
              <label>Guest name<input value={form.guestName} onChange={(e) => update('guestName', e.target.value)} /></label>
              <label>Email<input type="email" value={form.guestEmail} onChange={(e) => update('guestEmail', e.target.value)} /></label>
              <label>Country code<input value={form.countryCode} onChange={(e) => update('countryCode', e.target.value)} /></label>
              <label>Phone<input value={form.guestPhone} onChange={(e) => update('guestPhone', e.target.value)} /></label>
              <label>Special requests<textarea value={form.specialRequests} onChange={(e) => update('specialRequests', e.target.value)} /></label>
              <button type="button" onClick={() => setStep(3)}>Continue to extras</button>
            </div>
          ) : null}

          {step === 3 ? (
            <div>
              <h2>Extras and discounts</h2>
              <div className="btb-reservation-desk__extras">
                {extras.map((extra) => (
                  <div key={extra.id}>
                    <strong>{extra.name}</strong>
                    <span>{extra.category} - {toMoney(extra.price)}</span>
                    <input
                      type="number"
                      min={0}
                      value={selectedExtras[extra.id] || 0}
                      onChange={(e) =>
                        setSelectedExtras((current) => ({
                          ...current,
                          [extra.id]: Math.max(0, Number(e.target.value)),
                        }))
                      }
                    />
                  </div>
                ))}
              </div>

              <h3>Other extras</h3>
              {otherExtras.map((row, index) => (
                <div className="btb-reservation-desk__inline" key={index}>
                  <input placeholder="Name" value={row.name} onChange={(e) => setOtherExtras((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: e.target.value } : item))} />
                  <input type="number" placeholder="Price" value={row.price} onChange={(e) => setOtherExtras((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, price: Number(e.target.value) } : item))} />
                  <input type="number" placeholder="Qty" value={row.quantity} onChange={(e) => setOtherExtras((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Number(e.target.value) } : item))} />
                  <button type="button" onClick={() => setOtherExtras((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Remove</button>
                </div>
              ))}
              <button type="button" onClick={() => setOtherExtras((current) => [...current, { name: '', price: 0, quantity: 1 }])}>Add custom extra</button>

              <div className="btb-reservation-desk__form">
                <label>Coupon
                  <select value={form.couponId} onChange={(e) => update('couponId', e.target.value)}>
                    <option value="">No coupon</option>
                    {coupons.map((coupon) => <option key={coupon.id} value={coupon.id}>{coupon.code}</option>)}
                  </select>
                </label>
                <label>Coupon code<input value={form.couponCode} onChange={(e) => update('couponCode', e.target.value)} placeholder="Optional manual code" /></label>
                <label>Custom discount amount<input type="number" min={0} value={form.customDiscountAmount} onChange={(e) => update('customDiscountAmount', Number(e.target.value))} /></label>
              </div>

              <button type="button" onClick={() => setStep(4)}>Continue to payment</button>
            </div>
          ) : null}

          {step === 4 ? (
            <div>
              <h2>Payment schedule</h2>
              <div className="btb-reservation-desk__form">
                <label>Reservation status
                  <select value={form.status} onChange={(e) => update('status', e.target.value)}>
                    <option value="pending">Pending</option>
                    <option value="awaiting payment">Awaiting Payment</option>
                    <option value="confirmed_balance_due">Confirmed - Balance Due</option>
                    <option value="confirmed">Confirmed</option>
                  </select>
                </label>
                <label>Default method
                  <select value={form.method} onChange={(e) => update('method', e.target.value)}>
                    <option value="Mamo Pay">Mamo Pay</option>
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Cash">Cash</option>
                  </select>
                </label>
              </div>

              {payments.map((payment, index) => (
                <div className="btb-reservation-desk__payment" key={index}>
                  <input type="number" value={payment.amount} onChange={(e) => updatePayment(index, 'amount', Number(e.target.value))} />
                  <select value={payment.kind} onChange={(e) => updatePayment(index, 'kind', e.target.value)}>
                    <option value="full">Full</option>
                    <option value="downpayment">Down payment</option>
                    <option value="installment">Installment</option>
                    <option value="balance">Balance</option>
                  </select>
                  <select value={payment.method} onChange={(e) => updatePayment(index, 'method', e.target.value)}>
                    <option value="Mamo Pay">Mamo Pay</option>
                    <option value="Bank Transfer">Bank Transfer</option>
                    <option value="Cash">Cash</option>
                  </select>
                  <select value={payment.status} onChange={(e) => updatePayment(index, 'status', e.target.value)}>
                    <option value="scheduled">Scheduled</option>
                    <option value="pending">Awaiting Payment</option>
                    <option value="completed">Received</option>
                  </select>
                  <input type="date" value={payment.date} onChange={(e) => updatePayment(index, 'date', e.target.value)} />
                  <button type="button" onClick={() => removePayment(index)}>Remove</button>
                </div>
              ))}
              <button type="button" onClick={addPayment}>Add payment row</button>
              <button type="button" onClick={() => setStep(5)}>Review booking</button>
            </div>
          ) : null}

          {step === 5 ? (
            <div>
              <h2>Review and create</h2>
              {created ? (
                <div className="btb-reservation-desk__created">
                  <strong>Reservation created</strong>
                  <span>{created.transactionId || created.id}</span>
                  <a href={created.adminUrl}>Open full reservation</a>
                </div>
              ) : (
                <button type="button" onClick={createReservation} disabled={loading || !form.boatId || !form.guestName || !form.guestPhone}>
                  {loading ? 'Creating...' : 'Create reservation'}
                </button>
              )}
            </div>
          ) : null}
        </section>

        <aside className="btb-reservation-desk__summary">
          <h2>Summary</h2>
          <dl>
            <dt>Yacht</dt><dd>{selectedBoat?.name || 'Not selected'}</dd>
            <dt>Trip</dt><dd>{form.date} at {form.startTime} for {form.duration}h</dd>
            <dt>Guests</dt><dd>{form.guests}</dd>
            <dt>Guest</dt><dd>{form.guestName || 'Not entered'}</dd>
            <dt>Subtotal</dt><dd>{toMoney(preview?.subtotalBeforeDiscount || 0)}</dd>
            <dt>Coupon discount</dt><dd>{toMoney(preview?.couponDiscount || 0)}</dd>
            <dt>Custom discount</dt><dd>{toMoney(preview?.customDiscount || 0)}</dd>
            <dt>Total</dt><dd><strong>{toMoney(preview?.totalPrice || 0)}</strong></dd>
          </dl>
          {preview?.couponMessage ? <p className="btb-reservation-desk__warning">{preview.couponMessage}</p> : null}
        </aside>
      </div>
    </main>
  )
}
