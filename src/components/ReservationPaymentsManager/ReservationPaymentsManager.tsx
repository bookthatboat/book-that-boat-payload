'use client'

import React, { useMemo } from 'react'
import { useField } from '@payloadcms/ui'

type PaymentMethod = 'Mamo Pay' | 'Bank Transfer' | 'Cash'
type PaymentStatus =
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

const toDatetimeLocal = (value?: string): string => {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const offset = date.getTimezoneOffset()
  const local = new Date(date.getTime() - offset * 60 * 1000)

  return local.toISOString().slice(0, 16)
}

const fromDatetimeLocal = (value: string): string => {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return date.toISOString()
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

const getPaymentStatusLabel = (status?: PaymentStatus): string => {
  switch (status) {
    case 'pending':
      return 'Pending'
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
      return 'Pending'
  }
}

const normaliseStatus = (status?: PaymentStatus): PaymentStatus => {
  return status || 'pending'
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

export function ReservationPaymentsManager() {
  const { value: totalPriceValue } = useField<number>({ path: 'totalPrice' })
  const { value: methodValue } = useField<PaymentMethod>({ path: 'method' })
  const { value: paymentsValue, setValue: setPaymentsValue } = useField<PaymentRow[]>({
    path: 'payments',
  })

  const totalPrice = Math.max(0, Math.round(toNumber(totalPriceValue)))
  const payments = useMemo(
    () => (Array.isArray(paymentsValue) ? paymentsValue : []),
    [paymentsValue],
  )

  const recalculatedPayments = useMemo(() => {
    let runningPaidOrPending = 0

    return payments.map((payment, index) => {
      const amount = Math.max(0, Math.round(toNumber(payment.amount)))
      const method = payment.method || methodValue || 'Mamo Pay'
      const status = normaliseStatus(payment.status)

      const shouldReduceBalance =
        status === 'pending' || status === 'completed'

      if (shouldReduceBalance) {
        runningPaidOrPending += amount
      }

      const feeFields = getFeeFields(amount, method)

      return {
        ...payment,
        id: payment.id || `manual-${Date.now()}-${index}`,
        kind: payment.kind || 'balance',
        amount,
        method,
        status,
        date: payment.date || new Date().toISOString(),
        createdAt: payment.createdAt || new Date().toISOString(),
        paidAt: status === 'completed' ? payment.paidAt || new Date().toISOString() : payment.paidAt || '',
        installmentStage:
          status === 'completed'
            ? 'paid'
            : payment.installmentStage ||
              (method === 'Mamo Pay' ? 'installed_ready_to_be_paid' : 'ready_to_be_installed'),
        balance: Math.max(0, totalPrice - runningPaidOrPending),
        ...feeFields,
      }
    })
  }, [methodValue, payments, totalPrice])

  const totals = useMemo(() => {
    return recalculatedPayments.reduce(
      (acc, payment) => {
        const amount = toNumber(payment.amount)

        if (payment.status === 'completed') {
          acc.received += amount
        }

        if (payment.status === 'pending') {
          acc.pending += amount
        }

        if (payment.status === 'refunded') {
          acc.refunded += amount
        }

        acc.mamoFees += toNumber(payment.processingFeeAmount)

        return acc
      },
      {
        received: 0,
        pending: 0,
        refunded: 0,
        mamoFees: 0,
      },
    )
  }, [recalculatedPayments])

  const uncovered = Math.max(0, totalPrice - totals.received - totals.pending)
  const receivedBalance = Math.max(0, totalPrice - totals.received)

  const updatePayments = (nextPayments: PaymentRow[]) => {
    setPaymentsValue(nextPayments)
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
      const feeFields = getFeeFields(amount, method)

      return {
        ...merged,
        amount,
        ...feeFields,
        paidAt:
          merged.status === 'completed'
            ? merged.paidAt || new Date().toISOString()
            : merged.status === 'pending'
              ? ''
              : merged.paidAt,
        installmentStage: merged.status === 'completed' ? 'paid' : merged.installmentStage,
      }
    })

    updatePayments(nextPayments)
  }

  const addPayment = () => {
    const amountAlreadyCovered = totals.received + totals.pending
    const suggestedAmount = Math.max(0, totalPrice - amountAlreadyCovered)
    const method = methodValue || 'Cash'
    const feeFields = getFeeFields(suggestedAmount, method)

    updatePayments([
      ...recalculatedPayments,
      {
        id: `manual-${Date.now()}`,
        kind: 'balance',
        amount: suggestedAmount,
        method,
        status: 'pending',
        date: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        paidAt: '',
        installmentStage: method === 'Mamo Pay' ? 'installed_ready_to_be_paid' : 'ready_to_be_installed',
        balance: 0,
        notes: '',
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

  const syncBalances = () => {
    updatePayments(recalculatedPayments)
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.header}>
        <h3 style={styles.title}>Payment Manager</h3>
        <p style={styles.help}>
          Add multiple payment rows for Mamo Pay, bank transfer, or cash. Use Pending when payment is
          expected, Received when money has been collected, and Refunded when it has been returned.
          Historical bookings are read from the existing payment ledger.
        </p>
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
          <div style={styles.label}>Pending</div>
          <div style={styles.value}>{money(totals.pending)}</div>
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
        <button type="button" onClick={addPayment} style={styles.button}>
          Add payment row
        </button>
        <button type="button" onClick={syncBalances} style={styles.button}>
          Recalculate balances
        </button>
      </div>

      <div style={styles.tableWrap}>
        {recalculatedPayments.length === 0 ? (
          <p style={styles.help}>No payment rows yet. Click “Add payment row” to record one.</p>
        ) : (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Amount</th>
                <th style={styles.th}>Method</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}>Date</th>
                <th style={styles.th}>Fee</th>
                <th style={styles.th}>Customer Pays</th>
                <th style={styles.th}>Balance</th>
                <th style={styles.th}>Link</th>
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
                    <td style={styles.td}>
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

                    <td style={styles.td}>
                      <select
                        value={payment.method || methodValue || 'Cash'}
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

                    <td style={styles.td}>
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
                          <option value="pending">Pending</option>
                          <option value="completed">Received</option>
                          <option value="refunded">Refunded</option>
                        </select>
                      )}
                    </td>

                    <td style={styles.td}>
                      <input
                        type="datetime-local"
                        value={toDatetimeLocal(payment.date)}
                        onChange={(event) =>
                          updatePayment(index, {
                            date: fromDatetimeLocal(event.target.value),
                          })
                        }
                        style={styles.input}
                      />
                    </td>

                    <td style={styles.td}>
                      {payment.method === 'Mamo Pay'
                        ? `${money(toNumber(payment.processingFeeAmount))} (${payment.processingFeePercentage || MAMO_PROCESSING_FEE_PERCENTAGE}%)`
                        : money(0)}
                    </td>

                    <td style={styles.td}>{money(toNumber(payment.customerPayableAmount))}</td>
                    <td style={styles.td}>{money(toNumber(payment.balance))}</td>

                    <td style={styles.td}>
                      {payment.paymentLink ? (
                        <a href={payment.paymentLink} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : (
                        '-'
                      )}
                    </td>

                    <td style={styles.td}>
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

                    <td style={styles.td}>
                      <button
                        type="button"
                        onClick={() => removePayment(index)}
                        style={styles.dangerButton}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

export default ReservationPaymentsManager
