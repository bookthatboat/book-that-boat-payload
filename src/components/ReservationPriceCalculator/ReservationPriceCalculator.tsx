'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useField } from '@payloadcms/ui'

type RelationshipValue = string | { id?: string } | null | undefined

type BoatDoc = {
  id: string
  price?: number
  priceDay?: number
  name?: string
}

type CouponDoc = {
  id: string
  code?: string
  type?: 'percentage' | 'fixed'
  amount?: number
  isActive?: boolean
  expiresAt?: string
  applyToAllBoats?: boolean
  boats?: RelationshipValue[]
}

type ExtraDoc = {
  id: string
  name?: string
  unitPrice?: number
}

type ReservationExtraRow = {
  extra?: RelationshipValue
  quantity?: number
  unitPrice?: number
}

type OtherExtraRow = {
  name?: string
  price?: number
  quantity?: number
}

type PaymentRow = {
  id?: string
  kind?: string
  amount?: number
  method?: string
  date?: string
  status?: string
  installmentStage?: string
  paidAt?: string
  balance?: number
  paymentLink?: string
  paymentLinkId?: string
  processingFeePercentage?: number
  processingFeeAmount?: number
  customerPayableAmount?: number
  notes?: string
}

const getRelationshipId = (value: RelationshipValue): string | null => {
  if (!value) return null
  if (typeof value === 'string') return value
  return value.id || null
}

const getRelationshipIds = (value: RelationshipValue[] | undefined): string[] => {
  if (!Array.isArray(value)) return []
  return value.map((item) => getRelationshipId(item)).filter(Boolean) as string[]
}

const toNumber = (value: unknown): number => {
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

const money = (value: number): string => {
  return `AED ${Math.max(0, Math.round(value)).toLocaleString()}`
}

const MAMO_PROCESSING_FEE_PERCENTAGE = 4

const getPaymentFeeDisplay = (payment: PaymentRow) => {
  const amount = toNumber(payment.amount)

  if (payment.method !== 'Mamo Pay') {
    return {
      percentage: 0,
      feeAmount: 0,
      customerPayableAmount: amount,
    }
  }

  const percentage = toNumber(payment.processingFeePercentage) || MAMO_PROCESSING_FEE_PERCENTAGE
  const feeAmount =
    toNumber(payment.processingFeeAmount) || Math.round(amount * (percentage / 100))
  const customerPayableAmount =
    toNumber(payment.customerPayableAmount) || amount + feeAmount

  return {
    percentage,
    feeAmount,
    customerPayableAmount,
  }
}

const formatDate = (value?: string): string => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'

  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

const calculateHours = (startTime?: string, endTime?: string): number => {
  if (!startTime || !endTime) return 0

  const start = new Date(startTime)
  const end = new Date(endTime)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0
  if (end <= start) return 0

  return Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60))
}

const calculateCouponDiscount = ({
  coupon,
  subtotalBeforeDiscount,
  boatId,
}: {
  coupon: CouponDoc | null
  subtotalBeforeDiscount: number
  boatId: string | null
}): number => {
  if (!coupon?.id || !coupon.isActive) return 0

  if (coupon.expiresAt) {
    const expiresAt = new Date(coupon.expiresAt)
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt < new Date()) return 0
  }

  if (!coupon.applyToAllBoats) {
    const allowedBoatIds = getRelationshipIds(coupon.boats)
    if (boatId && allowedBoatIds.length > 0 && !allowedBoatIds.includes(boatId)) return 0
  }

  const amount = toNumber(coupon.amount)

  if (coupon.type === 'percentage') {
    return Math.min(subtotalBeforeDiscount, subtotalBeforeDiscount * (amount / 100))
  }

  if (coupon.type === 'fixed') {
    return Math.min(subtotalBeforeDiscount, amount)
  }

  return 0
}

const styles = {
  wrap: {
    marginBottom: 24,
    border: '1px solid var(--theme-elevation-150)',
    borderRadius: 8,
    background: 'var(--theme-elevation-50)',
    color: 'var(--theme-text)',
    overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    padding: 16,
    borderBottom: '1px solid var(--theme-elevation-150)',
  } as React.CSSProperties,
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 700,
  } as React.CSSProperties,
  help: {
    margin: '8px 0 0',
    color: 'var(--theme-elevation-500)',
    fontSize: 13,
    lineHeight: 1.5,
  } as React.CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
    gap: 12,
    padding: 16,
  } as React.CSSProperties,
  card: {
    border: '1px solid var(--theme-elevation-150)',
    borderRadius: 6,
    padding: 12,
    background: 'var(--theme-elevation-100)',
  } as React.CSSProperties,
  label: {
    color: 'var(--theme-elevation-500)',
    fontSize: 12,
    marginBottom: 4,
  } as React.CSSProperties,
  value: {
    fontWeight: 700,
    fontSize: 15,
  } as React.CSSProperties,
  total: {
    padding: 16,
    borderTop: '1px solid var(--theme-elevation-150)',
    fontSize: 18,
    fontWeight: 800,
    color: 'var(--theme-success-500)',
  } as React.CSSProperties,
  error: {
    padding: 16,
    color: 'var(--theme-error-500)',
    fontSize: 13,
  } as React.CSSProperties,
}

const getReservationIdFromAdminUrl = (): string | null => {
  if (typeof window === 'undefined') return null

  const match = window.location.pathname.match(/\/admin\/collections\/reservations\/([^/?#]+)/)
  const reservationId = match?.[1]

  if (!reservationId || reservationId === 'create') return null

  return decodeURIComponent(reservationId)
}

const getPaymentSessionKey = (reservationId: string) => {
  return `reservation-payments:${reservationId}`
}

const readPaymentsFromSession = (reservationId: string): PaymentRow[] | null => {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.sessionStorage.getItem(getPaymentSessionKey(reservationId))
    if (!raw) return null

    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const fetchReservationPayments = async (reservationId: string): Promise<PaymentRow[] | null> => {
  const response = await fetch(`/api/reservations/${reservationId}?depth=0`, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
  })

  if (!response.ok) return null

  const json = await response.json().catch(() => null)
  const doc = json?.doc || json

  return Array.isArray(doc?.payments) ? doc.payments : null
}

export function ReservationPriceCalculator() {
  const { value: boatValue } = useField<RelationshipValue>({ path: 'boat' })
  const { value: startTime } = useField<string>({ path: 'startTime' })
  const { value: endTime } = useField<string>({ path: 'endTime' })
  const { value: extrasValue, setValue: setExtrasValue } = useField<ReservationExtraRow[]>({
    path: 'extras',
  })
  const { value: otherExtrasValue } = useField<OtherExtraRow[]>({ path: 'otherExtras' })
  const { value: couponValue } = useField<RelationshipValue>({ path: 'coupon' })
  const { value: customDiscountAmountValue } = useField<number>({
    path: 'customDiscountAmount',
  })
  const { value: paymentsValue } = useField<PaymentRow[]>({ path: 'payments' })
  const { setValue: setTotalPriceValue } = useField<number>({ path: 'totalPrice' })

  const [boat, setBoat] = useState<BoatDoc | null>(null)
  const [coupon, setCoupon] = useState<CouponDoc | null>(null)
  const [extraDocsById, setExtraDocsById] = useState<Record<string, ExtraDoc>>({})
  const [error, setError] = useState('')

  const lastHydratedExtrasKeyRef = useRef('')

  const boatId = getRelationshipId(boatValue)
  const couponId = getRelationshipId(couponValue)

  const extras = useMemo(() => (Array.isArray(extrasValue) ? extrasValue : []), [extrasValue])
  const otherExtras = useMemo(
    () => (Array.isArray(otherExtrasValue) ? otherExtrasValue : []),
    [otherExtrasValue],
  )
  const reservationIdForPayments = getReservationIdFromAdminUrl()

  const [livePayments, setLivePayments] = useState<PaymentRow[]>(() => {
    if (reservationIdForPayments) {
      const sessionPayments = readPaymentsFromSession(reservationIdForPayments)
      if (sessionPayments && sessionPayments.length > 0) return sessionPayments
    }

    return Array.isArray(paymentsValue) ? paymentsValue : []
  })

  const paymentsValueKey = useMemo(() => {
    if (!Array.isArray(paymentsValue)) return '[]'

    return JSON.stringify(
      paymentsValue.map((payment) => ({
        id: payment?.id,
        amount: payment?.amount,
        method: payment?.method,
        status: payment?.status,
        date: payment?.date,
        paidAt: payment?.paidAt,
        paymentLink: payment?.paymentLink,
        paymentLinkId: payment?.paymentLinkId,
      })),
    )
  }, [paymentsValue])

  useEffect(() => {
    let cancelled = false

    const hydratePayments = async () => {
      if (Array.isArray(paymentsValue) && paymentsValue.length > 0) {
        setLivePayments(paymentsValue)
        return
      }

      if (!reservationIdForPayments) return

      const sessionPayments = readPaymentsFromSession(reservationIdForPayments)

      if (sessionPayments && sessionPayments.length > 0) {
        setLivePayments(sessionPayments)
      }

      const apiPayments = await fetchReservationPayments(reservationIdForPayments)

      if (!cancelled && apiPayments && apiPayments.length > 0) {
        setLivePayments(apiPayments)

        try {
          window.sessionStorage.setItem(
            getPaymentSessionKey(reservationIdForPayments),
            JSON.stringify(apiPayments),
          )
        } catch {
          // Ignore storage errors. This is only a UI fallback.
        }
      }
    }

    void hydratePayments()

    return () => {
      cancelled = true
    }
  }, [paymentsValueKey, paymentsValue, reservationIdForPayments])

  useEffect(() => {
    const handlePaymentsUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ reservationId?: string; payments?: PaymentRow[] }>

      if (
        reservationIdForPayments &&
        customEvent.detail?.reservationId &&
        customEvent.detail.reservationId !== reservationIdForPayments
      ) {
        return
      }

      if (Array.isArray(customEvent.detail?.payments)) {
        setLivePayments(customEvent.detail.payments)
      }
    }

    window.addEventListener('reservation-payments-updated', handlePaymentsUpdated)

    return () => {
      window.removeEventListener('reservation-payments-updated', handlePaymentsUpdated)
    }
  }, [reservationIdForPayments])

  const payments = livePayments

  useEffect(() => {
    if (!boatId) {
      setBoat(null)
      return
    }

    let cancelled = false

    async function loadBoat() {
      try {
        const response = await fetch(`/api/boats/${boatId}?depth=0`, {
          credentials: 'include',
        })

        if (!response.ok) return

        const json = await response.json()
        const doc = json?.doc || json

        if (!cancelled) setBoat(doc)
      } catch {
        if (!cancelled) setError('Could not load boat pricing.')
      }
    }

    loadBoat()

    return () => {
      cancelled = true
    }
  }, [boatId])

  useEffect(() => {
    if (!couponId) {
      setCoupon(null)
      return
    }

    let cancelled = false

    async function loadCoupon() {
      try {
        const response = await fetch(`/api/coupons/${couponId}?depth=1`, {
          credentials: 'include',
        })

        if (!response.ok) return

        const json = await response.json()
        const doc = json?.doc || json

        if (!cancelled) setCoupon(doc)
      } catch {
        if (!cancelled) setError('Could not load coupon.')
      }
    }

    loadCoupon()

    return () => {
      cancelled = true
    }
  }, [couponId])

  const selectedExtraIds = useMemo(() => {
    return extras.map((row) => getRelationshipId(row.extra)).filter(Boolean) as string[]
  }, [extras])

  useEffect(() => {
    const missingIds = selectedExtraIds.filter((id) => !extraDocsById[id])
    if (missingIds.length === 0) return

    let cancelled = false

    async function loadExtras() {
      try {
        const entries = await Promise.all(
          missingIds.map(async (id) => {
            const response = await fetch(`/api/extras/${id}?depth=0`, {
              credentials: 'include',
            })

            if (!response.ok) return null

            const json = await response.json()
            const doc = json?.doc || json

            return doc?.id ? ([id, doc] as const) : null
          }),
        )

        if (cancelled) return

        const loaded = entries.reduce<Record<string, ExtraDoc>>((acc, entry) => {
          if (!entry) return acc
          acc[entry[0]] = entry[1]
          return acc
        }, {})

        if (Object.keys(loaded).length > 0) {
          setExtraDocsById((previous) => ({ ...previous, ...loaded }))
        }
      } catch {
        if (!cancelled) setError('Could not load selected extra prices.')
      }
    }

    loadExtras()

    return () => {
      cancelled = true
    }
  }, [extraDocsById, selectedExtraIds])

  useEffect(() => {
    const extrasKey = JSON.stringify(
      extras.map((row) => ({
        extra: getRelationshipId(row.extra),
        quantity: row.quantity,
        unitPrice: row.unitPrice,
      })),
    )

    if (extrasKey === lastHydratedExtrasKeyRef.current) return

    const hydratedExtras = extras.map((row) => {
      const extraId = getRelationshipId(row.extra)
      const extraDoc = extraId ? extraDocsById[extraId] : null

      if (!extraDoc || toNumber(row.unitPrice) > 0) return row

      return {
        ...row,
        quantity: row.quantity || 1,
        unitPrice: toNumber(extraDoc.unitPrice),
      }
    })

    const hydratedKey = JSON.stringify(
      hydratedExtras.map((row) => ({
        extra: getRelationshipId(row.extra),
        quantity: row.quantity,
        unitPrice: row.unitPrice,
      })),
    )

    if (hydratedKey !== extrasKey) {
      lastHydratedExtrasKeyRef.current = hydratedKey
      setExtrasValue(hydratedExtras)
    }
  }, [extraDocsById, extras, setExtrasValue])

  const calculation = useMemo(() => {
    const hours = calculateHours(startTime, endTime)
    const hourlyPrice = toNumber(boat?.price)
    const dailyPrice = toNumber(boat?.priceDay)

    let basePrice = 0

    if (hours >= 24) {
      basePrice = Math.ceil(hours / 24) * dailyPrice
    } else if (hours > 0) {
      basePrice = hours * hourlyPrice
    }

    const extrasTotal = extras.reduce((sum, row) => {
      const extraId = getRelationshipId(row.extra)
      const fallbackUnitPrice = extraId ? toNumber(extraDocsById[extraId]?.unitPrice) : 0
      const unitPrice = toNumber(row.unitPrice) || fallbackUnitPrice
      const quantity = Math.max(1, toNumber(row.quantity) || 1)

      return sum + unitPrice * quantity
    }, 0)

    const otherExtrasTotal = otherExtras.reduce((sum, row) => {
      const unitPrice = toNumber(row.price)
      const quantity = Math.max(1, toNumber(row.quantity) || 1)

      return sum + unitPrice * quantity
    }, 0)

    const subtotalBeforeDiscount = basePrice + extrasTotal + otherExtrasTotal

    const couponDiscount = calculateCouponDiscount({
      coupon,
      subtotalBeforeDiscount,
      boatId,
    })

    const customDiscountAmount = Math.min(
      subtotalBeforeDiscount,
      Math.max(0, toNumber(customDiscountAmountValue)),
    )

    const totalDiscount = Math.min(subtotalBeforeDiscount, couponDiscount + customDiscountAmount)
    const finalTotal = Math.max(0, subtotalBeforeDiscount - totalDiscount)

    const paidAmount = payments.reduce((sum, payment) => {
      const isCompleted = payment?.status === 'completed' || payment?.installmentStage === 'paid'
      if (!isCompleted) return sum
      return sum + toNumber(payment.amount)
    }, 0)

    const pendingAmount = payments.reduce((sum, payment) => {
      if (payment?.status !== 'pending' && payment?.status !== 'scheduled') return sum
      return sum + toNumber(payment.amount)
    }, 0)

    const processingFeeTotal = payments.reduce((sum, payment) => {
      const display = getPaymentFeeDisplay(payment)
      return sum + display.feeAmount
    }, 0)

    const customerPayableTotal = payments.reduce((sum, payment) => {
      const display = getPaymentFeeDisplay(payment)
      return sum + display.customerPayableAmount
    }, 0)

    const balanceDue = Math.max(0, finalTotal - paidAmount - pendingAmount)
    const overpaidAmount = Math.max(0, paidAmount - finalTotal)

    return {
      hours,
      basePrice,
      extrasTotal,
      otherExtrasTotal,
      subtotalBeforeDiscount,
      couponDiscount,
      customDiscountAmount,
      totalDiscount,
      finalTotal,
      paidAmount,
      pendingAmount,
      processingFeeTotal,
      customerPayableTotal,
      balanceDue,
      overpaidAmount,
    }
  }, [
    boat?.price,
    boat?.priceDay,
    boatId,
    coupon,
    customDiscountAmountValue,
    endTime,
    extraDocsById,
    extras,
    otherExtras,
    payments,
    startTime,
  ])

  useEffect(() => {
    const nextTotal = Math.round(calculation.finalTotal)
    setTotalPriceValue(nextTotal)

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('reservation-total-updated', {
          detail: {
            reservationId: reservationIdForPayments || undefined,
            totalPrice: nextTotal,
          },
        }),
      )
    }
  }, [calculation.finalTotal, reservationIdForPayments, setTotalPriceValue])

  return (
    <div className="btb-reservation-price" style={styles.wrap}>
      <div className="btb-reservation-price__header" style={styles.header}>
        <h3 style={styles.title}>Live Reservation Price</h3>
        <p style={styles.help}>
          This summary updates when the boat, time, extras, additional items, coupon, or custom
          discount changes. Manage all payment rows, due dates, received dates, methods, links and
          statuses in the Payment Schedule Manager below.
        </p>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div className="btb-reservation-price__grid" style={styles.grid}>
        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Duration</div>
          <div style={styles.value}>{calculation.hours || 0} hour(s)</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Boat price</div>
          <div style={styles.value}>{money(calculation.basePrice)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Extras</div>
          <div style={styles.value}>{money(calculation.extrasTotal)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Additional items</div>
          <div style={styles.value}>{money(calculation.otherExtrasTotal)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Coupon discount</div>
          <div style={styles.value}>-{money(calculation.couponDiscount)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Custom discount</div>
          <div style={styles.value}>-{money(calculation.customDiscountAmount)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Paid</div>
          <div style={styles.value}>{money(calculation.paidAmount)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Pending / scheduled</div>
          <div style={styles.value}>{money(calculation.pendingAmount)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Mamo fee total</div>
          <div style={styles.value}>{money(calculation.processingFeeTotal)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Customer payable total</div>
          <div style={styles.value}>{money(calculation.customerPayableTotal)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Balance still due</div>
          <div style={styles.value}>{money(calculation.balanceDue)}</div>
        </div>

        <div className="btb-reservation-price__card" style={styles.card}>
          <div style={styles.label}>Overpaid / review</div>
          <div style={styles.value}>{money(calculation.overpaidAmount)}</div>
        </div>
      </div>

      <div style={styles.total}>
        Final total: {money(calculation.finalTotal)} | Paid: {money(calculation.paidAmount)} |
        Pending / scheduled: {money(calculation.pendingAmount)}
      </div>

    </div>
  )
}

export default ReservationPriceCalculator
