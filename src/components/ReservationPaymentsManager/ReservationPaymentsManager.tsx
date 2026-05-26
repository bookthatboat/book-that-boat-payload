'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useField } from '@payloadcms/ui'

type PaymentMethod = 'Mamo Pay' | 'Bank Transfer' | 'Cash'
type PaymentStatus =
  | 'scheduled'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'cancelled'
  | 'superseded'

type PaymentKind = 'full' | 'downpayment' | 'installment' | 'balance' | 'adjustment'

type PaymentRow = {
  id?: string
  kind?: PaymentKind
  installmentStage?: string
  createdAt?: string
  installedAt?: string
  paidAt?: string
  amount?: number
  method?: PaymentMethod
  date?: string
  status?: PaymentStatus
  balance?: number
  notes?: string
  paymentLink?: string
  paymentLinkId?: string
  actualPaymentLink?: string
  actualPaymentLinkId?: string
  actualMamoChargeId?: string
  actualMamoChargeStatus?: string
  actualCapturedAmount?: number
  actualCapturedFeeAmount?: number
  actualCapturedNetAmount?: number
  actualCapturedCurrency?: string
  actualCapturedAt?: string
  reconciledAt?: string
  reconciledBy?: string
  reconciliationSource?: string
  reconciliationNotes?: string
  processingFeePercentage?: number
  processingFeeAmount?: number
  customerPayableAmount?: number
}

const MAMO_PROCESSING_FEE_PERCENTAGE = 4

const toNumber = (value: unknown): number => {
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

const money = (value: number): string => {
  return `AED ${Math.max(0, Math.round(value)).toLocaleString()}`
}

const toDateInputValue = (value?: string): string => {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return date.toISOString().slice(0, 10)
}

const fromDateInputValue = (value: string): string => {
  if (!value) return ''

  // Store date-only values at midday UTC to avoid timezone display shifts.
  return new Date(`${value}T12:00:00.000Z`).toISOString()
}

const todayInputValue = () => {
  return new Date().toISOString().slice(0, 10)
}

const getDefaultScheduleDate = ({
  reservationCreatedDate,
  tripStartDate,
}: {
  reservationCreatedDate?: string
  tripStartDate?: string
}) => {
  const today = todayInputValue()

  if (reservationCreatedDate && today < reservationCreatedDate) {
    return reservationCreatedDate
  }

  if (tripStartDate && today > tripStartDate) {
    return tripStartDate
  }

  return today
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

const readSavedPaymentsFromSession = (reservationId: string): PaymentRow[] | null => {
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

const writeSavedPaymentsToSession = (reservationId: string, payments: PaymentRow[]) => {
  if (typeof window === 'undefined') return

  try {
    window.sessionStorage.setItem(getPaymentSessionKey(reservationId), JSON.stringify(payments))
  } catch {
    // Ignore storage errors. This is only a UI fallback.
  }
}

const dispatchPaymentsUpdatedEvent = (reservationId: string, payments: PaymentRow[]) => {
  if (typeof window === 'undefined') return

  window.dispatchEvent(
    new CustomEvent('reservation-payments-updated', {
      detail: {
        reservationId,
        payments,
      },
    }),
  )
}

const fetchReservationPayments = async (reservationId: string): Promise<PaymentRow[] | null> => {
  const response = await fetch(`/api/reservations/${reservationId}/payment-state`, {
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

const getFeeFields = (amount: number, method?: PaymentMethod) => {
  const safeAmount = Math.max(0, Math.round(toNumber(amount)))

  if (method !== 'Mamo Pay') {
    return {
      processingFeePercentage: 0,
      processingFeeAmount: 0,
      customerPayableAmount: safeAmount,
    }
  }

  const processingFeeAmount = Math.round(safeAmount * (MAMO_PROCESSING_FEE_PERCENTAGE / 100))

  return {
    processingFeePercentage: MAMO_PROCESSING_FEE_PERCENTAGE,
    processingFeeAmount,
    customerPayableAmount: safeAmount + processingFeeAmount,
  }
}

const getDefaultPaymentKind = (payments: PaymentRow[], index: number): PaymentKind => {
  if (payments.length <= 1) return 'full'
  if (index === 0) return 'downpayment'
  return 'balance'
}

const getPaymentMethodForSchedule = (payments: PaymentRow[]) => {
  const activeRows = payments.filter((payment) =>
    ['scheduled', 'pending', 'completed'].includes(payment.status || ''),
  )

  const hasScheduleRows =
    activeRows.length > 1 ||
    payments.some((payment) =>
      payment.status === 'scheduled' ||
      payment.kind === 'downpayment' ||
      payment.kind === 'installment' ||
      payment.kind === 'balance',
    )

  return hasScheduleRows ? 'scheduled' : 'full'
}

const normalisePaymentRowsForSave = ({
  payments,
  totalPrice,
  methodValue,
  paymentPlanValue,
}: {
  payments: PaymentRow[]
  totalPrice: number
  methodValue?: PaymentMethod
  paymentPlanValue?: string
}): PaymentRow[] => {
  const now = new Date().toISOString()
  let runningPaidOrPending = 0

  return payments.map((payment, index) => {
    const amount = Math.max(0, Math.round(toNumber(payment.amount)))
    const method = payment.method || methodValue || 'Mamo Pay'
    const status = normaliseStatus(payment.status)

    if (status === 'scheduled' || status === 'pending' || status === 'completed') {
      runningPaidOrPending += amount
    }

    const feeFields = getFeeFields(amount, method)
    const date = payment.date || now
    const createdAt = payment.createdAt || now

    return {
      ...payment,
      id: payment.id || `payment-${index}`,
      kind: payment.kind || getDefaultPaymentKind(payments, index),
      amount,
      method,
      status,
      date,
      createdAt,
      paidAt: status === 'completed' ? payment.paidAt || now : payment.paidAt || '',
      installmentStage:
        status === 'completed'
          ? 'paid'
          : payment.installmentStage ||
            (method === 'Mamo Pay' ? 'ready_to_be_installed' : 'ready_to_be_installed'),
      balance: Math.max(0, totalPrice - runningPaidOrPending),
      ...feeFields,
    }
  })
}

const getPaymentStatusLabel = (status?: PaymentStatus): string => {
  switch (status) {
    case 'scheduled':
      return 'Scheduled'
    case 'pending':
      return 'Awaiting Payment'
    case 'completed':
      return 'Received'
    case 'refunded':
      return 'Refunded'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'superseded':
      return 'Superseded'
    default:
      return 'Scheduled'
  }
}

const normaliseStatus = (status?: PaymentStatus): PaymentStatus => {
  return status || 'scheduled'
}

const isActive = (payment: PaymentRow) => {
  return payment.status === 'scheduled' || payment.status === 'pending' || payment.status === 'completed'
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
  warning: {
    margin: '8px 0 0',
    color: 'var(--theme-warning-500)',
    fontSize: 13,
    lineHeight: 1.5,
  } as React.CSSProperties,
  summary: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: 12,
    padding: 16,
    borderBottom: '1px solid var(--theme-elevation-150)',
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
  actions: {
    padding: 16,
    borderBottom: '1px solid var(--theme-elevation-150)',
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
  } as React.CSSProperties,
  reconcilePanel: {
    margin: 16,
    padding: 16,
    border: '1px solid var(--theme-elevation-200)',
    borderRadius: 8,
    background: 'var(--theme-elevation-100)',
  } as React.CSSProperties,
  button: {
    border: '1px solid var(--theme-elevation-250)',
    borderRadius: 6,
    background: 'var(--theme-elevation-100)',
    color: 'var(--theme-text)',
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,
  dangerButton: {
    border: '1px solid var(--theme-error-500)',
    borderRadius: 6,
    background: 'var(--theme-elevation-100)',
    color: 'var(--theme-error-500)',
    padding: '8px 12px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  } as React.CSSProperties,
  tableWrap: {
    padding: 16,
    overflowX: 'auto',
  } as React.CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  } as React.CSSProperties,
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    borderBottom: '1px solid var(--theme-elevation-150)',
    color: 'var(--theme-elevation-500)',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  td: {
    padding: '8px 10px',
    borderBottom: '1px solid var(--theme-elevation-100)',
    verticalAlign: 'top',
  } as React.CSSProperties,
  input: {
    width: '100%',
    minWidth: 120,
    border: '1px solid var(--theme-elevation-200)',
    borderRadius: 6,
    background: 'var(--theme-input-bg)',
    color: 'var(--theme-text)',
    padding: '7px 9px',
    fontSize: 13,
  } as React.CSSProperties,
  small: {
    color: 'var(--theme-elevation-500)',
    fontSize: 12,
    lineHeight: 1.4,
  } as React.CSSProperties,
}

export function ReservationPaymentsManager({ path = 'payments' }: { path?: string }) {
  const { value: totalPriceValue } = useField<number>({ path: 'totalPrice' })
  const { value: methodValue } = useField<PaymentMethod>({ path: 'method' })
  const { value: paymentPlanValue } = useField<string>({ path: 'paymentMethod' })
  const { value: startTimeValue } = useField<string>({ path: 'startTime' })
  const { value: createdAtValue } = useField<string>({ path: 'createdAt' })
  const { value: paymentsValue, setValue: setPaymentsValue } = useField<PaymentRow[]>({
    path,
  })

  const reservationIdForState = getReservationIdFromAdminUrl()
  const [liveTotalPrice, setLiveTotalPrice] = useState(() =>
    Math.max(0, Math.round(toNumber(totalPriceValue))),
  )

  const totalPrice = liveTotalPrice

  const [localPayments, setLocalPayments] = useState<PaymentRow[]>(() => {
    if (reservationIdForState) {
      const sessionPayments = readSavedPaymentsFromSession(reservationIdForState)
      if (sessionPayments && sessionPayments.length > 0) return sessionPayments
    }

    return Array.isArray(paymentsValue) ? paymentsValue : []
  })

  const [hasHydratedPaymentsFromServer, setHasHydratedPaymentsFromServer] = useState(false)
  const latestPaymentsRef = useRef<PaymentRow[]>(localPayments)
  const hasUserEditedPaymentsRef = useRef(false)

  useEffect(() => {
    latestPaymentsRef.current = localPayments
  }, [localPayments])

  useEffect(() => {
    setLiveTotalPrice(Math.max(0, Math.round(toNumber(totalPriceValue))))
  }, [totalPriceValue])

  useEffect(() => {
    const handleTotalUpdated = (event: Event) => {
      const customEvent = event as CustomEvent<{ reservationId?: string; totalPrice?: number }>

      if (
        reservationIdForState &&
        customEvent.detail?.reservationId &&
        customEvent.detail.reservationId !== reservationIdForState
      ) {
        return
      }

      const nextTotal = Math.max(0, Math.round(toNumber(customEvent.detail?.totalPrice)))
      setLiveTotalPrice(nextTotal)
    }

    window.addEventListener('reservation-total-updated', handleTotalUpdated)

    return () => {
      window.removeEventListener('reservation-total-updated', handleTotalUpdated)
    }
  }, [reservationIdForState])

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
    if (!reservationIdForState || hasHydratedPaymentsFromServer) return

    let isActive = true

    const hydratePaymentsFromServer = async () => {
      try {
        const serverPayments = await fetchReservationPayments(reservationIdForState)

        if (!isActive) return

        if (Array.isArray(serverPayments) && serverPayments.length > 0) {
          setLocalPayments(serverPayments)
          setPaymentsValue(serverPayments)
          writeSavedPaymentsToSession(reservationIdForState, serverPayments)
          dispatchPaymentsUpdatedEvent(reservationIdForState, serverPayments)
          return
        }

        const sessionPayments = readSavedPaymentsFromSession(reservationIdForState)

        if (sessionPayments && sessionPayments.length > 0) {
          setLocalPayments(sessionPayments)
          setPaymentsValue(sessionPayments)
          dispatchPaymentsUpdatedEvent(reservationIdForState, sessionPayments)
          return
        }

        if (Array.isArray(paymentsValue) && paymentsValue.length > 0) {
          setLocalPayments(paymentsValue)
          writeSavedPaymentsToSession(reservationIdForState, paymentsValue)
          dispatchPaymentsUpdatedEvent(reservationIdForState, paymentsValue)
          return
        }

        setLocalPayments([])
      } catch (error) {
        console.error('[ReservationPaymentsManager] Failed to hydrate payments on first load', error)

        if (!isActive) return

        const sessionPayments = readSavedPaymentsFromSession(reservationIdForState)

        if (sessionPayments && sessionPayments.length > 0) {
          setLocalPayments(sessionPayments)
          setPaymentsValue(sessionPayments)
          dispatchPaymentsUpdatedEvent(reservationIdForState, sessionPayments)
        }
      } finally {
        if (isActive) {
          setHasHydratedPaymentsFromServer(true)
        }
      }
    }

    void hydratePaymentsFromServer()

    return () => {
      isActive = false
    }
  }, [
    reservationIdForState,
    hasHydratedPaymentsFromServer,
    paymentsValue,
    setPaymentsValue,
  ])

  useEffect(() => {
    if (!Array.isArray(paymentsValue)) return

    const nextPayments = paymentsValue.filter(Boolean)

    // Payload admin can initially provide an empty payments array before the
    // document/custom field has fully hydrated. Do not let that first empty value
    // clear real saved payments.
    if (!hasHydratedPaymentsFromServer && nextPayments.length === 0) {
      return
    }

    // Once the admin starts editing payment rows, local state becomes the source
    // of truth until Save Schedule or server hydration explicitly resets the edit flag.
    // Payload Admin can re-emit stale non-empty form state after select/date/input changes,
    // especially on mobile, which would otherwise revert edits such as Mamo Pay -> Cash.
    if (hasUserEditedPaymentsRef.current) {
      return
    }

    // After hydration, still ignore stale empty form-state updates if we already
    // have rows locally and the user has not intentionally cleared/edited them.
    if (
      hasHydratedPaymentsFromServer &&
      nextPayments.length === 0 &&
      latestPaymentsRef.current.length > 0
    ) {
      return
    }

    setLocalPayments(nextPayments)

    if (reservationIdForState) {
      writeSavedPaymentsToSession(reservationIdForState, nextPayments)
      dispatchPaymentsUpdatedEvent(reservationIdForState, nextPayments)
    }
  }, [
    paymentsValueKey,
    paymentsValue,
    hasHydratedPaymentsFromServer,
    reservationIdForState,
  ])

  const payments = localPayments

  useEffect(() => {
    if (!reservationIdForState || localPayments.length === 0) return

    writeSavedPaymentsToSession(reservationIdForState, localPayments)
    dispatchPaymentsUpdatedEvent(reservationIdForState, localPayments)
  }, [reservationIdForState, localPayments])

  const [isSavingPayments, setIsSavingPayments] = useState(false)
  const [saveMessage, setSaveMessage] = useState('')
  const [saveError, setSaveError] = useState('')
  const [selectedLinkPayment, setSelectedLinkPayment] = useState<PaymentRow | null>(null)
  const [reconcileOpen, setReconcileOpen] = useState(false)
  const [selectedReconcileRows, setSelectedReconcileRows] = useState<number[]>([])
  const [actualPaymentLink, setActualPaymentLink] = useState('')
  const [actualPaymentLinkId, setActualPaymentLinkId] = useState('')
  const [actualMamoChargeId, setActualMamoChargeId] = useState('')
  const [reconciliationNotes, setReconciliationNotes] = useState('')
  const [isReconciling, setIsReconciling] = useState(false)

  const tripStartDate = toDateInputValue(startTimeValue)
  const reservationCreatedDate = toDateInputValue(createdAtValue) || todayInputValue()

  const recalculatedPayments = useMemo(() => {
    let runningPaidOrPending = 0

    return payments.map((payment, index) => {
      const amount = Math.max(0, Math.round(toNumber(payment.amount)))
      const method = payment.method || methodValue || 'Mamo Pay'
      const status = normaliseStatus(payment.status)

      if (status === 'scheduled' || status === 'pending' || status === 'completed') {
        runningPaidOrPending += amount
      }

      const feeFields = getFeeFields(amount, method)

      return {
        ...payment,
        id: payment.id || `payment-${index}`,
        kind: payment.kind || (paymentPlanValue === 'full' ? 'full' : 'balance'),
        amount,
        method,
        status,
        date: payment.date || '',
        createdAt: payment.createdAt || '',
        paidAt: status === 'completed' ? payment.paidAt || '' : payment.paidAt || '',
        installmentStage:
          status === 'completed'
            ? 'paid'
            : payment.installmentStage ||
              (method === 'Mamo Pay' ? 'ready_to_be_installed' : 'ready_to_be_installed'),
        balance: Math.max(0, totalPrice - runningPaidOrPending),
        ...feeFields,
      }
    })
  }, [methodValue, paymentPlanValue, payments, totalPrice])

  const totals = useMemo(() => {
    return recalculatedPayments.reduce(
      (acc, payment) => {
        const amount = toNumber(payment.amount)

        if (payment.status === 'completed') acc.received += amount
        if (payment.status === 'pending') acc.awaiting += amount
        if (payment.status === 'scheduled') acc.scheduled += amount
        if (payment.status === 'refunded') acc.refunded += amount
        if (isActive(payment)) acc.active += amount

        acc.mamoFees += toNumber(payment.processingFeeAmount)

        return acc
      },
      {
        received: 0,
        awaiting: 0,
        scheduled: 0,
        refunded: 0,
        active: 0,
        mamoFees: 0,
      },
    )
  }, [recalculatedPayments])

  const uncovered = Math.max(0, totalPrice - totals.active)
  const receivedBalance = Math.max(0, totalPrice - totals.received)

  const persistPayments = async (nextPayments: PaymentRow[]) => {
    const reservationId = getReservationIdFromAdminUrl()

    if (!reservationId) {
      setSaveError('Save the reservation first, then you can save payment rows from the Payment Manager.')
      return
    }

    const paymentsToSave = normalisePaymentRowsForSave({
      payments: nextPayments,
      totalPrice,
      methodValue,
      paymentPlanValue,
    })

    setLocalPayments(paymentsToSave)
    setPaymentsValue(paymentsToSave)

    if (reservationIdForState) {
      writeSavedPaymentsToSession(reservationIdForState, paymentsToSave)
      dispatchPaymentsUpdatedEvent(reservationIdForState, paymentsToSave)
    }

    setIsSavingPayments(true)
    setSaveMessage('')
    setSaveError('')

    try {
      const response = await fetch(`/api/reservations/${reservationId}/save-payments`, {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payments: paymentsToSave,
          paymentMethod: getPaymentMethodForSchedule(paymentsToSave),
        }),
      })

      const responseText = await response.text()
      let json: any = null

      try {
        json = responseText ? JSON.parse(responseText) : null
      } catch {
        json = null
      }

      console.info('Payment schedule save response', {
        status: response.status,
        submittedPaymentsCount: json?.submittedPaymentsCount,
        paymentsCount: json?.paymentsCount,
        savedPaymentsLength: Array.isArray(json?.savedPayments) ? json.savedPayments.length : null,
        docPaymentsLength: Array.isArray(json?.doc?.payments) ? json.doc.payments.length : null,
        message: json?.message,
        errors: json?.errors,
        rawResponse: json ? undefined : responseText,
      })

      if (!response.ok) {
        const message =
          json?.errors?.[0]?.message ||
          json?.message ||
          'Could not save payment schedule.'

        throw new Error(message)
      }

      const doc = json?.doc || json
      const savedPayments = Array.isArray(json?.savedPayments)
        ? json.savedPayments
        : Array.isArray(doc?.payments)
          ? doc.payments
          : null

      if (paymentsToSave.length > 0 && json?.paymentsCount === 0) {
        throw new Error(
          'Payment schedule was submitted but the backend returned zero saved payment rows.',
        )
      }

      if (paymentsToSave.length > 0 && Array.isArray(savedPayments) && savedPayments.length === 0) {
        throw new Error(
          'Payment schedule was submitted but the backend returned an empty payment schedule.',
        )
      }

      const paymentsToRender =
        Array.isArray(savedPayments) && savedPayments.length > 0 ? savedPayments : paymentsToSave

      // The save-payments endpoint already returns the saved payment rows.
      // Avoid an immediate follow-up reservation GET because it can intermittently 500
      // during read-after-write/activation timing even though the save itself succeeded.
      // Update local render state first so the table does not disappear even if Payload's
      // internal form state is stale, empty, or remounted after the API save.
      setLocalPayments(paymentsToRender)
      setPaymentsValue(paymentsToRender)
      writeSavedPaymentsToSession(reservationId, paymentsToRender)
      dispatchPaymentsUpdatedEvent(reservationId, paymentsToRender)
      hasUserEditedPaymentsRef.current = false

      setSaveMessage(`Payment schedule saved. Rows saved: ${paymentsToRender.length}.`)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save payment schedule.')
    } finally {
      setIsSavingPayments(false)
    }
  }

  const updatePayments = (nextPayments: PaymentRow[]) => {
    hasUserEditedPaymentsRef.current = true

    setLocalPayments(nextPayments)
    setPaymentsValue(nextPayments)

    if (reservationIdForState) {
      writeSavedPaymentsToSession(reservationIdForState, nextPayments)
      dispatchPaymentsUpdatedEvent(reservationIdForState, nextPayments)
    }

    setSaveMessage('')
    setSaveError('')
  }

  const updatePayment = (index: number, patch: Partial<PaymentRow>) => {
    const nextPayments = recalculatedPayments.map((payment, paymentIndex) => {
      if (paymentIndex !== index) return payment

      const merged = {
        ...payment,
        ...patch,
      }

      const amount = Math.max(0, Math.round(toNumber(merged.amount)))
      const method = merged.method || 'Mamo Pay'
      const status = normaliseStatus(merged.status)
      const feeFields = getFeeFields(amount, method)

      return {
        ...merged,
        amount,
        method,
        status,
        ...feeFields,
        paidAt:
          status === 'completed' || status === 'refunded'
            ? merged.paidAt || new Date().toISOString()
            : status === 'scheduled' || status === 'pending'
              ? ''
              : merged.paidAt,
        installmentStage: status === 'completed' ? 'paid' : merged.installmentStage,
      }
    })

    updatePayments(nextPayments)
  }

  const addPayment = () => {
    const amountAlreadyCovered = totals.active
    const suggestedAmount = Math.max(0, totalPrice - amountAlreadyCovered)
    const method = 'Mamo Pay'
    const feeFields = getFeeFields(suggestedAmount, method)

    const defaultScheduleDate = fromDateInputValue(
      getDefaultScheduleDate({
        reservationCreatedDate,
        tripStartDate,
      }),
    )

    updatePayments([
      ...recalculatedPayments,
      {
        id: `payment-${Date.now()}`,
        kind: recalculatedPayments.length === 0 ? 'downpayment' : 'balance',
        amount: suggestedAmount,
        method,
        status: 'scheduled',
        date: defaultScheduleDate,
        createdAt: new Date().toISOString(),
        paidAt: '',
        installmentStage: 'ready_to_be_installed',
        balance: 0,
        notes: '',
        paymentLink: '',
        paymentLinkId: '',
        ...feeFields,
      },
    ])
  }

  const createFullPaymentRow = () => {
    const method = 'Mamo Pay'
    const feeFields = getFeeFields(totalPrice, method)

    const defaultScheduleDate = fromDateInputValue(
      getDefaultScheduleDate({
        reservationCreatedDate,
        tripStartDate,
      }),
    )

    updatePayments([
      {
        id: `payment-${Date.now()}`,
        kind: 'full',
        amount: totalPrice,
        method,
        status: 'pending',
        date: defaultScheduleDate,
        createdAt: new Date().toISOString(),
        paidAt: '',
        installmentStage: 'ready_to_be_installed',
        balance: 0,
        notes: 'Full payment',
        paymentLink: '',
        paymentLinkId: '',
        ...feeFields,
      },
    ])
  }

  const removePayment = (index: number) => {
    const payment = recalculatedPayments[index]

    if (payment?.status === 'completed') {
      const confirmed = window.confirm(
        'This payment is marked as received. Instead of deleting it, consider changing the status to Refunded. Delete anyway?',
      )

      if (!confirmed) return
    }

    updatePayments(recalculatedPayments.filter((_, paymentIndex) => paymentIndex !== index))
  }

  const toggleReconcileRow = (index: number) => {
    setSelectedReconcileRows((previous) =>
      previous.includes(index)
        ? previous.filter((item) => item !== index)
        : [...previous, index].sort((a, b) => a - b),
    )
  }

  const resetReconciliationForm = () => {
    setSelectedReconcileRows([])
    setActualPaymentLink('')
    setActualPaymentLinkId('')
    setActualMamoChargeId('')
    setReconciliationNotes('')
  }

  const reconcileSelectedPayments = async () => {
    const reservationId = getReservationIdFromAdminUrl()

    if (!reservationId) {
      setSaveError('Save the reservation first, then you can add a manual Mamo payment.')
      return
    }

    if (!actualMamoChargeId.trim()) {
      setSaveError('Enter the unique Mamo PAY-ID / payment reference first. The system will fetch amount and status from Mamo.')
      return
    }

    const confirmed = window.confirm(
      `Fetch Mamo payment ${actualMamoChargeId.trim()} and add it as a Received payment line?`,
    )

    if (!confirmed) return

    setIsReconciling(true)
    setSaveMessage('')
    setSaveError('')

    try {
      const response = await fetch(`/api/reservations/${reservationId}/manual-mamo-payment`, {
        method: 'PATCH',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          paymentId: actualMamoChargeId,
          notes: reconciliationNotes,
        }),
      })

      const json = await response.json().catch(() => null)

      if (!response.ok) {
        throw new Error(json?.message || 'Could not add manual Mamo payment.')
      }

      const savedPayments = Array.isArray(json?.savedPayments)
        ? json.savedPayments
        : Array.isArray(json?.doc?.payments)
          ? json.doc.payments
          : null

      if (!Array.isArray(savedPayments)) {
        throw new Error('Manual Mamo payment was added but no saved payment rows were returned.')
      }

      setLocalPayments(savedPayments)
      setPaymentsValue(savedPayments)
      writeSavedPaymentsToSession(reservationId, savedPayments)
      dispatchPaymentsUpdatedEvent(reservationId, savedPayments)
      hasUserEditedPaymentsRef.current = false

      resetReconciliationForm()
      setReconcileOpen(false)

      setSaveMessage(
        `Manual Mamo payment added. Paid total: ${money(toNumber(json?.paidTotal))}. Superseded old rows: ${json?.supersededIndexes?.length || 0}.`,
      )
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not add manual Mamo payment.')
    } finally {
      setIsReconciling(false)
    }
  }

  const syncBalances = () => {
    updatePayments(recalculatedPayments)
  }

  const scheduleWarning =
    uncovered > 0
      ? `Payment schedule is short by ${money(uncovered)}. Add another row before moving the reservation to awaiting payment or confirmed.`
      : ''

  return (
    <div style={styles.wrap}>
      <style>
        {`
          @media (max-width: 760px) {
            .btb-payment-table {
              padding: 12px !important;
              overflow-x: visible !important;
            }

            .btb-payment-table table,
            .btb-payment-table thead,
            .btb-payment-table tbody,
            .btb-payment-table tr,
            .btb-payment-table td {
              display: block;
              width: 100%;
              box-sizing: border-box;
            }

            .btb-payment-table thead {
              display: none;
            }

            .btb-payment-table tr {
              margin-bottom: 12px;
              padding: 12px;
              border: 1px solid var(--theme-elevation-150);
              border-radius: 8px;
              background: var(--theme-elevation-100);
            }

            .btb-payment-table td {
              border-bottom: 0 !important;
              padding: 8px 0 !important;
            }

            .btb-payment-table td::before {
              content: attr(data-label);
              display: block;
              margin-bottom: 4px;
              color: var(--theme-elevation-500);
              font-size: 12px;
              font-weight: 700;
            }

            .btb-payment-table input,
            .btb-payment-table select,
            .btb-payment-table textarea {
              width: 100% !important;
              max-width: 100% !important;
              min-width: 0 !important;
              box-sizing: border-box;
            }

            .btb-payment-table button {
              width: 100%;
            }
          }
        `}
      </style>
      <div style={styles.header}>
        <h3 style={styles.title}>Payment Schedule Manager</h3>
        <p style={styles.help}>
          Build the customer payment schedule here. Scheduled Mamo Pay rows create and email payment
          links on the due date. Bank Transfer and Cash rows send manual payment instructions.
        </p>
        {scheduleWarning && <p style={styles.warning}>{scheduleWarning}</p>}
      </div>

      <div style={styles.summary}>
        <div style={styles.card}>
          <div style={styles.label}>Reservation total</div>
          <div style={styles.value}>{money(totalPrice)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.label}>Received</div>
          <div style={styles.value}>{money(totals.received)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.label}>Awaiting payment</div>
          <div style={styles.value}>{money(totals.awaiting)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.label}>Scheduled</div>
          <div style={styles.value}>{money(totals.scheduled)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.label}>Uncovered balance</div>
          <div style={styles.value}>{money(uncovered)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.label}>Balance after received only</div>
          <div style={styles.value}>{money(receivedBalance)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.label}>Refunded</div>
          <div style={styles.value}>{money(totals.refunded)}</div>
        </div>
        <div style={styles.card}>
          <div style={styles.label}>Mamo fee total</div>
          <div style={styles.value}>{money(totals.mamoFees)}</div>
        </div>
      </div>

      <div style={styles.actions}>
        <button type="button" onClick={createFullPaymentRow} style={styles.button}>
          Create full payment row
        </button>
        <button type="button" onClick={addPayment} style={styles.button}>
          Add scheduled payment row
        </button>
        <button type="button" onClick={syncBalances} style={styles.button}>
          Recalculate balances
        </button>

        <button
          type="button"
          onClick={() => setReconcileOpen((open) => !open)}
          style={styles.button}
        >
          Add manual Mamo payment
        </button>
        <button
          type="button"
          onClick={() => persistPayments(recalculatedPayments)}
          disabled={isSavingPayments}
          style={{
            ...styles.button,
            opacity: isSavingPayments ? 0.6 : 1,
            cursor: isSavingPayments ? 'not-allowed' : 'pointer',
          }}
        >
          {isSavingPayments ? 'Saving...' : 'Save payment schedule'}
        </button>
      </div>

      {(saveMessage || saveError) && (
        <div
          style={{
            padding: '0 16px 16px',
            color: saveError ? 'var(--theme-error-500)' : 'var(--theme-success-500)',
            fontSize: 13,
          }}
        >
          {saveError || saveMessage}
        </div>
      )}

      {reconcileOpen && (
        <div style={styles.reconcilePanel}>
          <h4 style={{ margin: '0 0 8px' }}>Add manual Mamo payment</h4>
          <p style={styles.help}>
            Use this when a customer has paid in Mamo and you need to record the received payment against this booking.
            Enter one unique PAY-ID. The system fetches the real amount, fee and status from Mamo, then adds a new Received payment line automatically.
          </p>

          <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginTop: 12 }}>
            <label>
              <div style={styles.label}>Mamo PAY-ID / Payment Reference *</div>
              <input
                value={actualMamoChargeId}
                onChange={(event) => setActualMamoChargeId(event.target.value)}
                placeholder="e.g. PAY-A8D8B99E63"
                style={styles.input}
              />
              <div style={styles.help}>
                Required. Enter the unique payment ID from Mamo. The system fetches the real amount, status and fee from Mamo.
              </div>
            </label>
          </div>

          <label style={{ display: 'block', marginTop: 12 }}>
            <div style={styles.label}>Admin Notes</div>
            <textarea
              value={reconciliationNotes}
              onChange={(event) => setReconciliationNotes(event.target.value)}
              placeholder="Example: Client paid both instalments using the second Mamo link. Reconciled by admin after checking Mamo."
              style={{
                ...styles.input,
                minHeight: 70,
              }}
            />
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <button
              type="button"
              onClick={reconcileSelectedPayments}
              disabled={isReconciling || !actualMamoChargeId.trim()}
              style={{
                ...styles.button,
                opacity: isReconciling || !actualMamoChargeId.trim() ? 0.6 : 1,
                cursor: isReconciling || !actualMamoChargeId.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {isReconciling ? 'Fetching from Mamo...' : 'Fetch PAY-ID and add received payment'}
            </button>

            <button
              type="button"
              onClick={resetReconciliationForm}
              disabled={isReconciling}
              style={styles.button}
            >
              Clear reconciliation form
            </button>
          </div>
        </div>
      )}

      <div className="btb-payment-table" style={styles.tableWrap}>
        {recalculatedPayments.length === 0 ? (
          <p style={styles.help}>
            No payment schedule yet. Click “Create full payment row” or “Add scheduled payment row”.
          </p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Amount</th>
                <th style={styles.th}>Scheduled Due Date</th>
                <th style={styles.th}>Received Date</th>
                <th style={styles.th}>Method</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Fee</th>
                <th style={styles.th}>Customer Pays</th>
                <th style={styles.th}>Balance</th>
                <th style={styles.th}>Link Details</th>
                <th style={styles.th}>Notes</th>
                <th style={styles.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recalculatedPayments.map((payment, index) => {
                const isSystemRow =
                  payment.status === 'superseded' ||
                  payment.status === 'cancelled' ||
                  payment.status === 'failed'

                return (
                  <tr key={payment.id || index}>
                    <td data-label="Amount" style={styles.td}>
                      <input
                        type="number"
                        min={0}
                        value={payment.amount || 0}
                        onChange={(event) =>
                          updatePayment(index, {
                            amount: Number(event.target.value),
                          })
                        }
                        style={styles.input}
                      />
                    </td>

                    <td data-label="Scheduled Due Date" style={styles.td}>
                      <input
                        type="date"
                        min={reservationCreatedDate || undefined}
                        max={tripStartDate || undefined}
                        value={toDateInputValue(payment.date)}
                        onChange={(event) =>
                          updatePayment(index, {
                            date: fromDateInputValue(event.target.value),
                          })
                        }
                        style={styles.input}
                      />
                      <div style={styles.small}>
                        Planned payment date. Must be between booking creation and trip date.
                      </div>
                    </td>

                    <td data-label="Received Date" style={styles.td}>
                      <input
                        type="date"
                        value={toDateInputValue(payment.paidAt)}
                        disabled={payment.status !== 'completed' && payment.status !== 'refunded'}
                        onChange={(event) =>
                          updatePayment(index, {
                            paidAt: fromDateInputValue(event.target.value),
                          })
                        }
                        style={{
                          ...styles.input,
                          opacity:
                            payment.status !== 'completed' && payment.status !== 'refunded'
                              ? 0.6
                              : 1,
                        }}
                      />
                      <div style={styles.small}>
                        {payment.status === 'completed'
                          ? 'Date received'
                          : payment.status === 'refunded'
                            ? 'Date refunded'
                            : 'Enabled once received/refunded'}
                      </div>
                    </td>

                    <td data-label="Method" style={styles.td}>
                      <select
                        value={payment.method || methodValue || 'Mamo Pay'}
                        onChange={(event) =>
                          updatePayment(index, {
                            method: event.target.value as PaymentMethod,
                          })
                        }
                        style={styles.input}
                      >
                        <option value="Mamo Pay">Mamo Pay</option>
                        <option value="Bank Transfer">Bank Transfer</option>
                        <option value="Cash">Cash</option>
                      </select>
                    </td>

                    <td data-label="Status" style={styles.td}>
                      {isSystemRow ? (
                        <div>
                          <strong>{getPaymentStatusLabel(payment.status)}</strong>
                          <div style={styles.small}>System status</div>
                        </div>
                      ) : (
                        <select
                          value={normaliseStatus(payment.status)}
                          onChange={(event) =>
                            updatePayment(index, {
                              status: event.target.value as PaymentStatus,
                            })
                          }
                          style={styles.input}
                        >
                          <option value="scheduled">Scheduled</option>
                          <option value="pending">Awaiting Payment</option>
                          <option value="completed">Received</option>
                          <option value="refunded">Refunded</option>
                        </select>
                      )}
                    </td>

                    <td data-label="Fee" style={styles.td}>
                      {payment.method === 'Mamo Pay'
                        ? `${money(toNumber(payment.processingFeeAmount))} (${payment.processingFeePercentage || MAMO_PROCESSING_FEE_PERCENTAGE}%)`
                        : money(0)}
                    </td>

                    <td data-label="Customer Pays" style={styles.td}>{money(toNumber(payment.customerPayableAmount))}</td>
                    <td data-label="Balance" style={styles.td}>{money(toNumber(payment.balance))}</td>

                    <td data-label="Link Details" style={styles.td}>
                      {payment.method === 'Mamo Pay' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <button
                            type="button"
                            onClick={() => setSelectedLinkPayment(payment)}
                            style={styles.button}
                          >
                            View Link Details
                          </button>
                          <div style={styles.small}>
                            {payment.paymentLink || payment.paymentLinkId
                              ? 'Link generated'
                              : payment.status === 'scheduled'
                                ? 'Not generated yet'
                                : 'No link saved'}
                          </div>
                        </div>
                      ) : (
                        <span style={styles.small}>Manual payment</span>
                      )}
                    </td>

                    <td data-label="Notes" style={styles.td}>
                      <textarea
                        value={payment.notes || ''}
                        onChange={(event) =>
                          updatePayment(index, {
                            notes: event.target.value,
                          })
                        }
                        style={{
                          ...styles.input,
                          minWidth: 220,
                          minHeight: 44,
                        }}
                      />
                    </td>

                    <td data-label="Actions" style={styles.td}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          onClick={() => persistPayments(recalculatedPayments)}
                          disabled={isSavingPayments}
                          style={{
                            ...styles.button,
                            opacity: isSavingPayments ? 0.6 : 1,
                            cursor: isSavingPayments ? 'not-allowed' : 'pointer',
                          }}
                        >
                          Save row
                        </button>

                        <button
                          type="button"
                          onClick={() => removePayment(index)}
                          style={styles.dangerButton}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {selectedLinkPayment && (
        <div
          style={{
            margin: '16px',
            padding: 16,
            border: '1px solid var(--theme-elevation-200)',
            borderRadius: 8,
            background: 'var(--theme-elevation-50)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              alignItems: 'flex-start',
              marginBottom: 12,
            }}
          >
            <div>
              <h4 style={{ margin: '0 0 4px' }}>Mamo Pay Link Details</h4>
              <div style={styles.small}>
                These details are read-only. Payment links are generated by Mamo Pay when a row is activated.
              </div>
            </div>

            <button type="button" onClick={() => setSelectedLinkPayment(null)} style={styles.button}>
              Close
            </button>
          </div>

          <div style={{ display: 'grid', gap: 10 }}>
            <div>
              <div style={styles.label}>Payment Link ID</div>
              <div style={styles.value}>{selectedLinkPayment.paymentLinkId || 'Not generated yet'}</div>
            </div>

            <div>
              <div style={styles.label}>Payment Link URL</div>
              {selectedLinkPayment.paymentLink ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <a href={selectedLinkPayment.paymentLink} target="_blank" rel="noreferrer">
                    Open payment link
                  </a>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(selectedLinkPayment.paymentLink || '')}
                    style={styles.button}
                  >
                    Copy link
                  </button>
                </div>
              ) : (
                <div style={styles.value}>Not generated yet</div>
              )}
            </div>

            {(selectedLinkPayment.actualPaymentLinkId ||
              selectedLinkPayment.actualPaymentLink ||
              selectedLinkPayment.actualMamoChargeId ||
              selectedLinkPayment.reconciledAt) && (
              <div>
                <div style={styles.label}>Actual Reconciled Payment</div>
                <div style={styles.small}>
                  {selectedLinkPayment.actualPaymentLinkId
                    ? `Actual link ID: ${selectedLinkPayment.actualPaymentLinkId}`
                    : ''}
                  {selectedLinkPayment.actualMamoChargeId
                    ? ` · Charge/reference: ${selectedLinkPayment.actualMamoChargeId}`
                    : ''}
                  {selectedLinkPayment.actualCapturedAmount
                    ? ` · Captured: ${money(toNumber(selectedLinkPayment.actualCapturedAmount))}`
                    : ''}
                  {selectedLinkPayment.reconciledAt
                    ? ` · Reconciled: ${toDateInputValue(selectedLinkPayment.reconciledAt)}`
                    : ''}
                </div>
              </div>
            )}

            <div style={styles.small}>
              Status: {getPaymentStatusLabel(selectedLinkPayment.status)} · Method:{' '}
              {selectedLinkPayment.method || 'Mamo Pay'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ReservationPaymentsManager
