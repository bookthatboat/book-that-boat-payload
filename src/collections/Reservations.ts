import type { CollectionConfig } from 'payload'
import { randomBytes, createHash, timingSafeEqual } from 'crypto'
import type { ReservationStatus } from '@/types/reservations'
import type { Boat } from '@/types/boats'
import type { User } from '@/types/users'
// import sgMail from '@sendgrid/mail'
import nodemailer from 'nodemailer'
import { sendEmailViaGraph } from '@/lib/graphMailer'
import { getCountries, getCountryCallingCode } from 'libphonenumber-js'
import {
  isProduction,
  isDevelopment,
  MAMOPAY_CONFIG,
  EMAIL_CONFIG,
  APP_URLS,
  DEFAULTS,
} from '@/config'

let mamoAuthBlockedUntil = 0
let mamoRateLimitedUntil = 0

const asDate = (v: Date | string): Date => {
  if (v instanceof Date) return v

  // If it's ISO, this works. If it's not, try to normalize or fallback.
  const d = new Date(v)
  if (!Number.isNaN(d.getTime())) return d

  // Last-resort: try replacing space with 'T' (common "YYYY-MM-DD HH:mm:ss")
  const d2 = new Date(String(v).replace(' ', 'T'))
  return d2
}

const formatDubaiDate = (v: Date | string) => {
  const d = asDate(v)
  if (Number.isNaN(d.getTime())) return 'Unknown date'

  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d)
}

const formatDubaiTime = (v: Date | string) => {
  const d = asDate(v)
  if (Number.isNaN(d.getTime())) return 'Unknown time'

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dubai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

const formatDubaiDateTime = (v: Date | string) => {
  const d = asDate(v)
  if (Number.isNaN(d.getTime())) return 'Unknown'

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dubai',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(d)
}

/* if (!process.env.SENDGRID_API_KEY) {
  throw new Error('SENDGRID_API_KEY missing in environment variables')
}

sgMail.setApiKey(process.env.SENDGRID_API_KEY!) */

const withWriteConflictRetry = async <T>(fn: () => Promise<T>, retries = 4) => {
  let lastErr: any

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      lastErr = err

      // Mongo write conflict (common codes/names)
      const code = err?.code
      const name = err?.codeName
      const msg = String(err?.message || '')

      const isWriteConflict =
        code === 112 ||
        name === 'WriteConflict' ||
        msg.toLowerCase().includes('write conflict') ||
        msg.toLowerCase().includes('conflict')

      if (!isWriteConflict || attempt === retries) throw err

      // Small backoff + jitter
      const base = 150 * (attempt + 1)
      const jitter = Math.floor(Math.random() * 100)
      await sleep(base + jitter)
    }
  }

  throw lastErr
}

/* const createTransporter = () => {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    requireTLS: true,
    auth: {
      type: "OAuth2",
      user: "web@bookthatboat.com",
      accessToken: "ya29.Xx_XX0xxxxx-xX0X0XxXXxXxXXXxX0x",
    },
  })
} */

type InstallmentStage = 'paid' | 'ready_to_be_installed' | 'installed_ready_to_be_paid'
type PaymentKind = 'full' | 'downpayment' | 'installment' | 'balance' | 'adjustment'
type PaymentStatus = 'scheduled' | 'pending' | 'completed' | 'failed' | 'refunded' | 'cancelled' | 'superseded'

const ACTIVE_RESERVATION_PAYMENT_STATUSES = ['awaiting payment', 'confirmed_balance_due'] as const

const RESERVATION_STATUS_OPTIONS: Array<{ label: string; value: ReservationStatus }> = [
  { label: 'Pending', value: 'pending' },
  { label: 'Awaiting Payment', value: 'awaiting payment' },
  { label: 'Confirmed - Balance Due', value: 'confirmed_balance_due' },
  { label: 'Confirmed', value: 'confirmed' },
  { label: 'Cancelled', value: 'cancelled' },
]

const ACTIVE_PAYMENT_ROW_STATUSES = new Set(['scheduled', 'pending', 'completed'])

type CancellationWindow =
  | 'more_than_72_hours'
  | 'between_24_and_72_hours'
  | 'less_than_24_hours'
  | 'trip_started'
  | 'unknown'

const getHoursUntilTrip = (startTime?: Date | string | null, now = new Date()): number | null => {
  if (!startTime) return null

  const tripStart = asDate(startTime)

  if (Number.isNaN(tripStart.getTime())) return null

  const hours = (tripStart.getTime() - now.getTime()) / (1000 * 60 * 60)

  return Math.round(hours * 10) / 10
}

const getCancellationPolicyResult = ({
  startTime,
  totalPrice,
  paidAmount,
  now = new Date(),
}: {
  startTime?: Date | string | null
  totalPrice?: number | null
  paidAmount?: number | null
  now?: Date
}) => {
  const hoursUntilTrip = getHoursUntilTrip(startTime, now)

  let cancellationWindow: CancellationWindow = 'unknown'
  let refundPercentage: 0 | 50 | 100 = 0

  if (hoursUntilTrip === null) {
    cancellationWindow = 'unknown'
    refundPercentage = 0
  } else if (hoursUntilTrip <= 0) {
    cancellationWindow = 'trip_started'
    refundPercentage = 0
  } else if (hoursUntilTrip <= 24) {
    cancellationWindow = 'less_than_24_hours'
    refundPercentage = 0
  } else if (hoursUntilTrip <= 72) {
    cancellationWindow = 'between_24_and_72_hours'
    refundPercentage = 50
  } else {
    cancellationWindow = 'more_than_72_hours'
    refundPercentage = 100
  }

  const safePaidAmount = Math.max(0, Number(paidAmount || 0))
  const safeTotalPrice = Math.max(0, Number(totalPrice || 0))
  const refundableBase = safePaidAmount > 0 ? safePaidAmount : safeTotalPrice
  const estimatedRefundAmount = Math.round(refundableBase * (refundPercentage / 100))

  return {
    hoursUntilTrip,
    cancellationWindow,
    refundPercentage,
    estimatedRefundAmount,
    canCustomerAddExtras: hoursUntilTrip !== null && hoursUntilTrip > 36,
  }
}

const getCompletedReservationPaidAmount = (reservation: any): number => {
  const payments = Array.isArray(reservation?.payments) ? reservation.payments : []

  return payments.reduce((sum: number, payment: any) => {
    if (payment?.status !== 'completed') return sum

    return sum + Number(payment?.amount || 0)
  }, 0)
}

const getReservationPolicyResult = (reservation: any) => {
  return getCancellationPolicyResult({
    startTime: reservation?.startTime,
    totalPrice: Number(reservation?.totalPrice || 0),
    paidAmount: getCompletedReservationPaidAmount(reservation),
  })
}


const getPaymentRequestRowForEmail = (reservation: any) => {
  const payments = Array.isArray(reservation?.payments) ? reservation.payments : []
  const topLevelPaymentLinkId = String(reservation?.paymentLinkId || '').trim()
  const topLevelPaymentLink = String(reservation?.paymentLink || '').trim()

  const byTopLevelLink = payments.find((payment: any) => {
    return (
      payment?.method === 'Mamo Pay' &&
      payment?.status === 'pending' &&
      (
        (topLevelPaymentLinkId && payment?.paymentLinkId === topLevelPaymentLinkId) ||
        (topLevelPaymentLink && payment?.paymentLink === topLevelPaymentLink)
      )
    )
  })

  if (byTopLevelLink) return byTopLevelLink

  const pendingMamoWithLink = payments.find((payment: any) => {
    return (
      payment?.method === 'Mamo Pay' &&
      payment?.status === 'pending' &&
      (payment?.paymentLink || payment?.paymentLinkId)
    )
  })

  if (pendingMamoWithLink) return pendingMamoWithLink

  const pendingMamo = payments.find((payment: any) => {
    return payment?.method === 'Mamo Pay' && payment?.status === 'pending'
  })

  if (pendingMamo) return pendingMamo

  return payments.find((payment: any) => payment?.status === 'pending') || null
}

const getReservationPaymentTotals = (payments: any[] | undefined, totalPrice: number) => {
  const activePayments = Array.isArray(payments)
    ? payments.filter((payment) => ACTIVE_PAYMENT_ROW_STATUSES.has(payment?.status || ''))
    : []

  const paidAmount = activePayments.reduce((sum, payment) => {
    if (payment?.status !== 'completed') return sum
    return sum + Number(payment.amount || 0)
  }, 0)

  const activeTotal = activePayments.reduce((sum, payment) => {
    return sum + Number(payment.amount || 0)
  }, 0)

  const roundedPaid = Math.round(paidAmount)
  const roundedTotal = Math.round(Number(totalPrice || 0))

  return {
    activePayments,
    paidAmount,
    activeTotal,
    isFullyPaid: roundedTotal > 0 && roundedPaid >= roundedTotal,
    hasPartialPayment: roundedPaid > 0 && roundedPaid < roundedTotal,
    hasOutstandingPayment:
      roundedTotal > 0 &&
      (roundedPaid < roundedTotal ||
        activePayments.some((payment) => payment?.status === 'scheduled' || payment?.status === 'pending')),
  }
}

const getReservationStatusFromPayments = ({
  payments,
  totalPrice,
}: {
  payments: any[] | undefined
  totalPrice: number
}): ReservationStatus => {
  const totals = getReservationPaymentTotals(payments, totalPrice)

  if (totals.isFullyPaid) return 'confirmed'

  if (totals.hasPartialPayment && totals.hasOutstandingPayment) {
    return 'confirmed_balance_due'
  }

  return 'awaiting payment'
}

const isScheduledPaymentPlan = (reservation: any) => {
  return (
    reservation?.paymentMethod === 'scheduled' ||
    reservation?.paymentMethod === 'installments' ||
    reservation?.paymentMethod === 'deposit_balance' ||
    (Array.isArray(reservation?.payments) && reservation.payments.length > 1)
  )
}

const MAMO_PROCESSING_FEE_PERCENTAGE = 4

const getPaymentFeeFields = ({
  amount,
  method,
}: {
  amount: number
  method?: 'Mamo Pay' | 'Bank Transfer' | 'Cash'
}) => {
  const safeAmount = Math.max(0, Number(amount || 0))

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

interface Reservation {
  id: string
  status: ReservationStatus
  user: string | User
  boat: string | Boat
  startTime: Date | string
  endTime: Date | string
  totalPrice: number
  paymentMethod?: 'full' | 'scheduled' | 'installments' | 'deposit_balance' | 'custom_schedule'
  method?: 'Mamo Pay' | 'Bank Transfer' | 'Cash'
  payments?: Array<{
    id?: string
    kind?: PaymentKind
    amount: number
    method: 'Mamo Pay' | 'Bank Transfer' | 'Cash'
    /**
     * For installments, `date` is the scheduled / due date (not the paid date).
     * We store the actual payment time in `paidAt`.
     */
    date: string
    status: PaymentStatus
    installmentStage?: InstallmentStage
    createdAt?: string
    installedAt?: string
    paidAt?: string
    balance: number
    notes: string
    paymentLink?: string
    paymentLinkId?: string
    processingFeePercentage?: number
    processingFeeAmount?: number
    customerPayableAmount?: number
  }>
  guests?: number
  guestName?: string
  guestEmail?: string
  guestPhone?: string
  specialRequests?: string
  extras?: any[]
  otherExtras?: {
    name: string
    price: number
    quantity: number
  }[]
  paymentLink?: string
  paymentLinkId?: string
  transactionId?: string
  boatHourlyPrice?: number
  boatDailyPrice?: number
  numberOfInstallments?: number
  downPaymentAmount?: number

  coupon?: string | { id: string }
  couponCode?: string
}

interface InstallmentReminder {
  reservationId: string
  paymentIndex: number
  sent: boolean
  scheduledTime: Date
}

// Payment polling system (store on globalThis to avoid duplicate intervals during Next.js dev HMR)
const JOBS_KEY = '__btb_reservation_jobs__' as const
const g = globalThis as any

if (!g[JOBS_KEY]) {
  g[JOBS_KEY] = {
    paymentPollingInterval: null as NodeJS.Timeout | null,
    reminderCheckInterval: null as NodeJS.Timeout | null,
    installmentSchedulerTimeout: null as NodeJS.Timeout | null,
    installmentSchedulerInterval: null as NodeJS.Timeout | null,
    processedReservations: new Set<string>(),
    lastCheckedByLink: new Map<string, number>(),
    installmentReminders: new Map<string, InstallmentReminder>(),
    lastInstallmentActivationKey: new Set<string>(), // `${reservationId}-${paymentId}`
    cleanupInterval: null as NodeJS.Timeout | null,
  }
}

const jobs = g[JOBS_KEY] as {
  paymentPollingInterval: NodeJS.Timeout | null
  reminderCheckInterval: NodeJS.Timeout | null
  installmentSchedulerTimeout: NodeJS.Timeout | null
  installmentSchedulerInterval: NodeJS.Timeout | null
  processedReservations: Set<string>
  lastCheckedByLink: Map<string, number>
  installmentReminders: Map<string, InstallmentReminder>
  lastInstallmentActivationKey: Set<string>
  cleanupInterval: NodeJS.Timeout | null
}

const scheduleDailyAt = (fn: () => Promise<void> | void, hour: number, minute: number) => {
  const now = new Date()
  const next = new Date(now)
  next.setHours(hour, minute, 0, 0)
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1)
  }
  const msUntilNext = next.getTime() - now.getTime()

  const timeout = setTimeout(async () => {
    try {
      await fn()
    } catch (e) {
      console.error('Daily installment scheduler error:', e)
    }
    const interval = setInterval(
      async () => {
        try {
          await fn()
        } catch (e) {
          console.error('Daily installment scheduler error:', e)
        }
      },
      24 * 60 * 60 * 1000,
    )

    jobs.installmentSchedulerInterval = interval
  }, msUntilNext)

  return timeout
}

export const startPaymentPolling = (payload: any) => {
  // Clear existing intervals (important in Next.js dev HMR to avoid duplicate pollers)
  if (jobs.paymentPollingInterval) {
    clearInterval(jobs.paymentPollingInterval)
    jobs.paymentPollingInterval = null
  }

  if (jobs.reminderCheckInterval) {
    clearInterval(jobs.reminderCheckInterval)
    jobs.reminderCheckInterval = null
  }

  // Poll payments (throttled per paymentLinkId inside checkPaymentStatuses)
  jobs.paymentPollingInterval = setInterval(
    async () => {
      try {
        await checkPaymentStatuses(payload)
      } catch (error) {
        console.error('Error in payment polling:', error)
      }
    },
    isProduction ? 30 * 60 * 1000 : 15 * 1000,
  )

  // Installment activation scheduler:
  // - runs IMMEDIATELY once (so newly created reservations get their down-payment email/link logic processed)
  // - then runs DAILY at a specific time (default 09:00 server time).
  // TIP: set TZ=Asia/Dubai on your server/process if you want this to align with Dubai time.
  try {
    void checkDueInstallments(payload)
    void activateDueScheduledPayments(payload)
  } catch (e) {
    console.error('Error running initial payment scheduler:', e)
  }

  // Clear any existing daily scheduler timers
  if (jobs.installmentSchedulerTimeout) {
    clearTimeout(jobs.installmentSchedulerTimeout)
    jobs.installmentSchedulerTimeout = null
  }
  if (jobs.installmentSchedulerInterval) {
    clearInterval(jobs.installmentSchedulerInterval)
    jobs.installmentSchedulerInterval = null
  }

  const schedulerHour = Number(process.env.INSTALLMENT_SCHEDULER_HOUR ?? 9)
  const schedulerMinute = Number(process.env.INSTALLMENT_SCHEDULER_MINUTE ?? 0)

  jobs.installmentSchedulerTimeout = scheduleDailyAt(
    async () => {
      await checkDueInstallments(payload)
      await activateDueScheduledPayments(payload)
    },
    Number.isFinite(schedulerHour) ? schedulerHour : 9,
    Number.isFinite(schedulerMinute) ? schedulerMinute : 0,
  )

  console.log('Payment status polling started')
  console.log(
    `Installment scheduler started (daily at ${schedulerHour}:${String(schedulerMinute).padStart(2, '0')})`,
  )
}

const checkDueInstallments = async (payload: any) => {
  try {
    const now = new Date()

    // Find all reservations with installment payments
    const reservations = await payload.find({
      collection: 'reservations',
      where: {
        and: [
          { status: { in: [...ACTIVE_RESERVATION_PAYMENT_STATUSES] } },
          { paymentMethod: { in: ['installments', 'deposit_balance', 'scheduled'] } },
        ],
      },
      depth: 1,
      overrideAccess: true,
    })

    // 1) Activate installments that are scheduled and ready
    for (const reservation of reservations.docs as any[]) {
      if (!reservation.payments || !Array.isArray(reservation.payments)) continue

      const boatId = typeof reservation.boat === 'object' ? reservation.boat.id : reservation.boat
      if (!boatId) continue

      const boat = (await payload.findByID({
        collection: 'boats',
        id: boatId,
        depth: 2,
        overrideAccess: true,
      })) as unknown as Boat

      if (!boat) continue

      const user = buildUserFromReservation(reservation)
      const updatedPayments = [...reservation.payments]
      let changed = false

      for (let i = 0; i < updatedPayments.length; i++) {
        const p = updatedPayments[i]
        if (!p) continue

        const isInstallment = (p.kind as PaymentKind) === 'installment'
        const stage = p.installmentStage as InstallmentStage | undefined

        // Only activate installments that are scheduled but not yet triggered
        if (
          isInstallment &&
          stage === 'ready_to_be_installed' &&
          p.status === 'pending' &&
          (!p.paymentLinkId || p.paymentLinkId === '')
        ) {
          const due = new Date(p.date)
          if (Number.isNaN(due.getTime())) continue

          if (due.getTime() <= now.getTime()) {
            const activationKey = `${reservation.id}-${p.id || i}`
            if (jobs.lastInstallmentActivationKey.has(activationKey)) continue
            jobs.lastInstallmentActivationKey.add(activationKey)

            // Create payment link for this installment
            const installmentReservation: Reservation = {
              ...(reservation as Reservation),
              totalPrice: p.amount,
            }

            const paymentLink = await createMamoPaymentLink(installmentReservation, boat, user, {
              installmentNumber: i + 1,
              totalInstallments: updatedPayments.length,
            })

            if (paymentLink) {
              updatedPayments[i] = {
                ...p,
                paymentLink: paymentLink.url,
                paymentLinkId: paymentLink.id,
                installmentStage: 'installed_ready_to_be_paid',
                installedAt: new Date().toISOString(),
              }

              changed = true

              // Send installment email to user + admin
              await sendInstallmentEmail(
                user,
                boat,
                reservation as Reservation,
                i + 1,
                updatedPayments.length,
                p.amount,
                paymentLink.url,
                p.date,
              )

              console.log(
                `Activated installment ${i + 1} for reservation ${reservation.id} (link created)`,
              )
            } else {
              console.warn(
                `Could not create payment link for installment ${i + 1} of reservation ${reservation.id}`,
              )
            }
          }
        }
      }

      if (changed) {
        await withWriteConflictRetry(() =>
          payload.update({
            collection: 'reservations',
            id: reservation.id,
            data: { payments: updatedPayments },
            overrideAccess: true,
            disableTransaction: true,
          }),
        )
      }
    }

    // 2) Reminder logic (optional): remind for active installments that are pending and already have a link
    const installmentReminders = jobs.installmentReminders

    for (const reservation of reservations.docs as any[]) {
      if (!reservation.payments || !Array.isArray(reservation.payments)) continue

      for (let i = 0; i < reservation.payments.length; i++) {
        const payment = reservation.payments[i]
        if (!payment) continue

        // Only remind for activated (link created) installments
        if ((payment.kind as PaymentKind) !== 'installment') continue

        const stage = payment.installmentStage as InstallmentStage | undefined
        if (payment.status !== 'pending') continue
        if (stage !== 'installed_ready_to_be_paid') continue
        if (!payment.paymentLink) continue

        const paymentDueDate = new Date(payment.date)
        const timeUntilDue = paymentDueDate.getTime() - now.getTime()
        const isDueWithin24Hours = timeUntilDue > 0 && timeUntilDue <= 24 * 60 * 60 * 1000
        const isOverdue = paymentDueDate.getTime() <= now.getTime()

        if (isDueWithin24Hours || isOverdue) {
          const reminderKey = `${reservation.id}-${i}`

          if (!installmentReminders.has(reminderKey)) {
            installmentReminders.set(reminderKey, {
              reservationId: reservation.id,
              paymentIndex: i,
              sent: false,
              scheduledTime: isOverdue
                ? now
                : new Date(paymentDueDate.getTime() - 24 * 60 * 60 * 1000),
            })
          }
        }
      }
    }

    for (const [key, reminder] of installmentReminders.entries()) {
      if (!reminder.sent && reminder.scheduledTime <= now) {
        try {
          const reservation = (await payload.findByID({
            collection: 'reservations',
            id: reminder.reservationId,
            depth: 1,
            overrideAccess: true,
          })) as any as Reservation

          if (!reservation?.payments?.[reminder.paymentIndex]) continue

          const payment = reservation.payments[reminder.paymentIndex]
          const boatId =
            typeof reservation.boat === 'object' ? reservation.boat.id : reservation.boat

          const boat = (await payload.findByID({
            collection: 'boats',
            id: boatId,
            depth: 2,
            overrideAccess: true,
          })) as unknown as Boat

          if (!boat) continue

          const user = buildUserFromReservation(reservation)

          await sendInstallmentReminderEmail(
            user,
            boat,
            reservation,
            reminder.paymentIndex + 1,
            reservation.payments.length,
            payment.amount,
            payment.paymentLink || '',
            payment.date,
          )

          reminder.sent = true
          installmentReminders.set(key, reminder)
        } catch (error) {
          console.error(`Error sending reminder for ${key}:`, error)
        }
      }
    }

    // Clean up sent reminders after 7 days
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    for (const [key, reminder] of installmentReminders.entries()) {
      if (reminder.sent && reminder.scheduledTime < oneWeekAgo) {
        installmentReminders.delete(key)
      }
    }
  } catch (error) {
    console.error('Error checking due installments:', error)
  }
}

const isRealMamoLinkId = (id?: string) => {
  if (!id) return false
  return /^MB-LINK-[A-Z0-9]+$/i.test(String(id).trim())
}

const isMockLinkId = (id?: string) => {
  if (!id) return false
  const v = String(id).trim()
  return v.startsWith('mock-link-') || v.startsWith('mock-')
}

const processedReservations = jobs.processedReservations

const checkPaymentStatuses = async (payload: any) => {
  try {
    console.log('Checking payment statuses...')

    // IMPORTANT: depth: 0 prevents populate from choking on legacy "" relationship values
    const reservations = await payload.find({
      collection: 'reservations',
      where: { status: { in: [...ACTIVE_RESERVATION_PAYMENT_STATUSES] } },
      depth: 0,
      overrideAccess: true,
    })

    console.log(`Found ${reservations.docs.length} reservations with active payment status`)

    // Throttle checks per paymentLinkId to avoid MamoPay 429
    const CHECK_THROTTLE_MS = isProduction ? 60 * 1000 : 20 * 1000

    for (const reservation of reservations.docs as any[]) {
      try {
        const reservationId = String(reservation?.id || '')
        if (!reservationId) continue

        const payments = Array.isArray(reservation.payments) ? reservation.payments : []
        const isInstallments = isScheduledPaymentPlan(reservation)

        const boatId =
          typeof reservation.boat === 'object' ? reservation.boat?.id : reservation.boat

        if (!boatId || boatId === '') {
          console.warn('[Polling][SKIP] reservation has no boat id:', reservationId)
          continue
        }

        const user = buildUserFromReservation(reservation)

        const topLevelLinkId =
          typeof reservation.paymentLinkId === 'string' ? reservation.paymentLinkId.trim() : ''

        // Build list of “payment entries” to poll
        const entriesToPoll: Array<{ index: number; payment: any; linkId: string }> = []

        if (isInstallments) {
          for (let i = 0; i < payments.length; i++) {
            const p = payments[i]
            if (!p) continue

            // Only check active payments that have a link
            if (p.status !== 'pending' || !p.paymentLinkId) continue

            // Only poll installment when activated
            if ((p.kind as PaymentKind) === 'installment') {
              const stage = p.installmentStage as InstallmentStage | undefined
              if (stage !== 'installed_ready_to_be_paid') continue
            }

            entriesToPoll.push({ index: i, payment: p, linkId: String(p.paymentLinkId) })
          }
        } else {
          // FULL PAYMENT path: prefer REAL top-level MB-LINK-*
          let linkIdToUse = ''
          const first = payments[0]

          if (topLevelLinkId && isRealMamoLinkId(topLevelLinkId)) {
            linkIdToUse = topLevelLinkId
          } else if (first?.paymentLinkId) {
            linkIdToUse = String(first.paymentLinkId).trim()
          } else if (topLevelLinkId) {
            linkIdToUse = topLevelLinkId
          }

          if (!linkIdToUse) {
            console.warn(
              '[Polling][SKIP] no paymentLinkId found for full-payment reservation:',
              reservationId,
            )
            continue
          }

          // If payment record has a mock id but top-level is real, always poll the real one
          if (topLevelLinkId && isRealMamoLinkId(topLevelLinkId) && isMockLinkId(linkIdToUse)) {
            linkIdToUse = topLevelLinkId
          }

          entriesToPoll.push({ index: 0, payment: first || null, linkId: linkIdToUse })
        }

        if (!entriesToPoll.length) continue

        for (const entry of entriesToPoll) {
          const { index: i, payment: p } = entry
          const linkId = String(entry.linkId || '').trim()
          if (!linkId) continue

          const lastChecked = jobs.lastCheckedByLink.get(linkId) || 0
          if (Date.now() - lastChecked < CHECK_THROTTLE_MS) continue
          jobs.lastCheckedByLink.set(linkId, Date.now())

          const reservationKey = `${reservationId}-${i}-${linkId}`
          if (processedReservations.has(reservationKey)) continue

          console.log(
            `[Polling] Checking Mamo status linkId=${linkId} reservation=${reservationId}`,
          )

          const isPaid = await checkMamoPaymentStatus(linkId)
          if (!isPaid) {
            console.log(`[Polling] Not captured yet linkId=${linkId}`)
            continue
          }

          console.log(`[Polling] CAPTURED ✅ linkId=${linkId} reservation=${reservationId}`)

          // Fetch boat only now (email needs it)
          const boat = (await payload.findByID({
            collection: 'boats',
            id: boatId,
            depth: 2,
            overrideAccess: true,
          })) as unknown as Boat

          if (!boat) {
            console.warn('[Polling][SKIP] boat not found for reservation:', reservationId)
            continue
          }

          const updatedPayments = [...payments]

          // Ensure there is at least one payment record for FULL payment
          if (!isInstallments && updatedPayments.length === 0) {
            updatedPayments.push({
              id: `payment-${Date.now()}`,
              amount: reservation.totalPrice || 0,
              method: reservation.method || 'Mamo Pay',
              date: new Date().toISOString(),
              status: 'pending',
              balance: 0,
              paymentLink: reservation.paymentLink || '',
              paymentLinkId: linkId,
              notes: 'Full payment',
            })
          }

          // Mark relevant payment as completed
          const targetIndex = isInstallments ? i : 0
          const existing = updatedPayments[targetIndex] || {}
          updatedPayments[targetIndex] = {
            ...existing,
            status: 'completed',
            paidAt: new Date().toISOString(),
            installmentStage: isInstallments ? 'paid' : existing.installmentStage,
            paymentLinkId: linkId, // store REAL id we validated
          }

          const nextReservationStatus = getReservationStatusFromPayments({
            payments: updatedPayments,
            totalPrice: Number(reservation.totalPrice || 0),
          })

          const allPaid = nextReservationStatus === 'confirmed'
          const isFirstSecuringPayment =
            reservation.status === 'awaiting payment' && nextReservationStatus === 'confirmed_balance_due'

          // ✅ Retry-safe update (prevents WriteConflict from “breaking” a reservation forever)
          try {
            await withWriteConflictRetry(() =>
              payload.update({
                collection: 'reservations',
                id: reservationId,
                data: {
                  payments: updatedPayments,
                  status: nextReservationStatus,
                  // ✅ Keep top-level accurate for FULL payments
                  ...(isInstallments ? {} : { paymentLinkId: linkId }),
                },
                overrideAccess: true,
                disableTransaction: true, // per-call safety
              }),
            )

            // ✅ Only mark processed AFTER update succeeds
            processedReservations.add(reservationKey)
          } catch (updateErr) {
            console.error(
              '[Polling] Update failed after capture (will retry next tick):',
              updateErr,
            )
            continue
          }

          // Send booking-secured email when first/deposit payment is received but balance remains
          if (isFirstSecuringPayment) {
            try {
              if (user.email) {
                await sendEmail(
                  user.email,
                  `Book That Boat - Booking Confirmed, Balance Due #${reservation.transactionId || reservation.id}`,
                  getStatusEmailContent('user', 'confirmed_balance_due', boat, user, {
                    ...reservation,
                    payments: updatedPayments,
                    status: nextReservationStatus,
                  } as Reservation),
                )
              }

              await sendEmail(
                EMAIL_CONFIG.adminEmail,
                `[Admin] Booking confirmed with balance due: ${boat.name}`,
                getStatusEmailContent('admin', 'confirmed_balance_due', boat, user, {
                  ...reservation,
                  payments: updatedPayments,
                  status: nextReservationStatus,
                } as Reservation),
              )
            } catch (err) {
              console.error('Failed sending confirmed balance due emails from polling:', err)
            }
          }

          // Only send "confirmed" emails when fully paid
          if (allPaid) {
            try {
              if (user.email) {
                await sendEmail(
                  user.email,
                  `Booking Status: confirmed`,
                  getStatusEmailContent(
                    'user',
                    'confirmed',
                    boat,
                    user,
                    reservation as Reservation,
                  ),
                )
              }

              await sendEmail(
                EMAIL_CONFIG.adminEmail,
                `[Admin] Booking confirmed: ${boat.name}`,
                getStatusEmailContent('admin', 'confirmed', boat, user, reservation as Reservation),
              )
            } catch (err) {
              console.error('Failed sending confirmed emails from polling:', err)
            }
          }

          // For full payment, stop after first capture+update
          if (!isInstallments) break
        }
      } catch (error) {
        console.error(`Error checking payment status for reservation ${reservation?.id}:`, error)
      }
    }
  } catch (error) {
    console.error('Error fetching reservations for payment check:', error)
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const checkMamoPaymentStatus = async (paymentLinkId: string): Promise<boolean> => {
  if (!paymentLinkId) return false

  const trimmedId = String(paymentLinkId).trim()

  // ✅ Never call Mamo for mock links (prevents pointless 429 spam)
  if (isMockLinkId(trimmedId)) {
    if (isDevelopment) {
      console.log(`[MamoPay] Skip status check for mock linkId=${trimmedId}`)
    }
    return false
  }

  // ✅ Respect a global 429 cooldown
  if (mamoRateLimitedUntil && Date.now() < mamoRateLimitedUntil) {
    if (isDevelopment) {
      console.warn(
        `[MamoPay] Rate-limited: skipping checks for ${Math.ceil(
          (mamoRateLimitedUntil - Date.now()) / 1000,
        )}s`,
      )
    }
    return false
  }

  // ✅ Respect a global auth cooldown
  if (mamoAuthBlockedUntil && Date.now() < mamoAuthBlockedUntil) {
    if (isDevelopment) {
      console.warn(
        `[MamoPay] Auth-blocked: skipping checks for ${Math.ceil(
          (mamoAuthBlockedUntil - Date.now()) / 1000,
        )}s`,
      )
    }
    return false
  }

  if (!MAMOPAY_CONFIG.apiKey) {
    console.log('MAMOPAY_API_KEY not found. Cannot check payment status.')
    return false
  }

  try {
    const encoded = encodeURIComponent(trimmedId)
    const maxPages = 2
    let page = 1

    while (page <= maxPages) {
      const response = await fetch(
        `${process.env.MAMOPAY_BASE_URL || MAMOPAY_CONFIG.baseUrl}/manage_api/v1/charges?page=${page}&per_page=50&payment_link_id=${encoded}`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${MAMOPAY_CONFIG.apiKey}`,
            accept: 'application/json',
          },
        },
      )

      // ✅ Handle rate limiting
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after')
        const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN

        const backoffMs = Number.isFinite(retryAfterSec)
          ? Math.max(5, retryAfterSec) * 1000
          : isProduction
            ? 60_000
            : 20_000

        mamoRateLimitedUntil = Date.now() + backoffMs

        const body = await response.text().catch(() => '')
        console.error(`MamoPay API 429 Too Many Requests. Backing off ${backoffMs}ms.`, body)
        return false
      }

      // ✅ Handle auth problems (keep your existing behaviour)
      if (response.status === 401 || response.status === 403) {
        const body = await response.text().catch(() => '')
        console.error(`MamoPay API auth error: ${response.status} ${response.statusText}`, body)

        mamoAuthBlockedUntil = Date.now() + (isProduction ? 30 * 60 * 1000 : 60 * 1000)
        return false
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        console.error(`MamoPay API error: ${response.status} ${response.statusText}`, body)
        return false
      }

      const data = await response.json().catch(() => null)

      if (data?.data && Array.isArray(data.data)) {
        const validPayment = data.data.find(
          (charge: any) =>
            String(charge?.status || '').toLowerCase() === 'captured' &&
            String(charge?.payment_link_id || '') === trimmedId,
        )

        if (validPayment) {
          console.log(`Found captured payment for payment link ${trimmedId}:`, {
            id: validPayment.id,
            status: validPayment.status,
            created_date: validPayment.created_date,
            amount: validPayment.amount,
          })
          return true
        }
      }

      const nextPage = data?.pagination_meta?.next_page
      if (!nextPage) break

      page = Number(nextPage)
      if (!Number.isFinite(page) || page <= 0) break
    }

    return false
  } catch (error) {
    console.error('Error checking payment status:', error)
    return false
  }
}


const toSafeISOString = (value: unknown, fallback = new Date().toISOString()) => {
  if (!value) return fallback

  const date = new Date(String(value))

  if (Number.isNaN(date.getTime())) {
    return fallback
  }

  return date.toISOString()
}

const normaliseMamoMoneyValue = (value: unknown) => {
  if (value === undefined || value === null || value === '') return 0

  const numericValue = Number(value)

  if (!Number.isFinite(numericValue)) return 0

  return Math.max(0, Math.round(numericValue))
}

const getMamoChargeId = (charge: any) => {
  return String(
    charge?.id ||
      charge?.charge_id ||
      charge?.payment_id ||
      charge?.paymentId ||
      charge?.transaction_id ||
      charge?.transactionId ||
      charge?.reference ||
      '',
  ).trim()
}

const getMamoChargePaymentLinkId = (charge: any) => {
  return String(
    charge?.payment_link_id ||
      charge?.paymentLinkId ||
      charge?.payment_link?.id ||
      charge?.paymentLink?.id ||
      charge?.payment_link_reference ||
      '',
  ).trim()
}

const getMamoChargeAmount = (charge: any) => {
  return normaliseMamoMoneyValue(
    charge?.amount ??
      charge?.captured_amount ??
      charge?.capturedAmount ??
      charge?.paid_amount ??
      charge?.paidAmount ??
      charge?.total_amount ??
      charge?.totalAmount,
  )
}

const getMamoChargeFee = (charge: any) => {
  return normaliseMamoMoneyValue(
    charge?.fee ??
      charge?.fees ??
      charge?.processing_fee ??
      charge?.processingFee ??
      charge?.mamo_fee ??
      charge?.mamoFee ??
      charge?.merchant_fee ??
      charge?.merchantFee,
  )
}

const getMamoChargeNetAmount = (charge: any) => {
  return normaliseMamoMoneyValue(
    charge?.net_amount ??
      charge?.netAmount ??
      charge?.settlement_amount ??
      charge?.settlementAmount ??
      charge?.amount_after_fees ??
      charge?.amountAfterFees,
  )
}

const splitMamoGrossAmount = ({
  grossAmount,
}: {
  grossAmount: number
  fetchedFee?: number
  fetchedNetAmount?: number
}) => {
  const safeGrossAmount = Math.max(0, Math.round(Number(grossAmount || 0)))

  if (safeGrossAmount <= 0) {
    return {
      baseAmount: 0,
      feeAmount: 0,
      customerPayableAmount: 0,
      netAmount: 0,
    }
  }

  // Mamo returns the gross/customer-paid amount for the PAY-ID.
  // Book That Boat charges the customer base amount + 4% surcharge.
  //
  // Example:
  // gross/customer paid = AED 884
  // base amount = 884 / 1.04 = AED 850
  // customer surcharge / Mamo fee shown in admin = AED 34
  //
  // Do not use Mamo's returned fee/net fields here, because those may represent
  // settlement/merchant-side fees rather than the customer surcharge.
  const baseAmount = Math.round(
    safeGrossAmount / (1 + MAMO_PROCESSING_FEE_PERCENTAGE / 100),
  )
  const feeAmount = Math.max(0, safeGrossAmount - baseAmount)

  return {
    baseAmount,
    feeAmount,
    customerPayableAmount: safeGrossAmount,
    netAmount: baseAmount,
  }
}

const getMamoChargeCapturedAt = (charge: any) => {
  return String(
    charge?.captured_at ||
      charge?.capturedAt ||
      charge?.created_date ||
      charge?.createdDate ||
      charge?.created_at ||
      charge?.createdAt ||
      '',
  ).trim()
}

const getMamoChargeStatus = (charge: any) => {
  return String(charge?.status || charge?.payment_status || charge?.paymentStatus || '').trim()
}

const fetchMamoChargesPage = async (page: number) => {
  if (!MAMOPAY_CONFIG.apiKey) {
    console.warn('[MamoPay] API key missing. Cannot fetch transactions.')
    return null
  }

  const response = await fetch(
    `${process.env.MAMOPAY_BASE_URL || MAMOPAY_CONFIG.baseUrl}/manage_api/v1/charges?page=${page}&per_page=50`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MAMOPAY_CONFIG.apiKey}`,
        accept: 'application/json',
      },
    },
  )

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error('[MamoPay] Failed to fetch transactions', {
      page,
      status: response.status,
      statusText: response.statusText,
      body,
    })

    throw new Error(`Mamo transaction fetch failed with status ${response.status}.`)
  }

  return response.json().catch(() => null)
}

const getMamoChargeByPaymentId = async (paymentId: string): Promise<any | null> => {
  const trimmedPaymentId = String(paymentId || '').trim()

  if (!trimmedPaymentId) return null
  if (isMockLinkId(trimmedPaymentId)) return null

  const maxPages = 10
  let page = 1

  while (page <= maxPages) {
    const data = await fetchMamoChargesPage(page)

    const charges = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.charges)
        ? data.charges
        : Array.isArray(data)
          ? data
          : []

    const matchedCharge = charges.find((charge: any) => {
      const chargeId = getMamoChargeId(charge)
      return chargeId.toLowerCase() === trimmedPaymentId.toLowerCase()
    })

    if (matchedCharge) return matchedCharge

    const nextPage =
      data?.pagination_meta?.next_page ||
      data?.pagination?.next_page ||
      data?.meta?.next_page ||
      null

    if (!nextPage) break

    const numericNextPage = Number(nextPage)

    if (!Number.isFinite(numericNextPage) || numericNextPage <= page) break

    page = numericNextPage
  }

  return null
}

const getMamoCapturedChargesForLink = async (paymentLinkId: string): Promise<any[]> => {
  if (!paymentLinkId) return []

  const trimmedId = String(paymentLinkId).trim()

  if (!trimmedId || isMockLinkId(trimmedId)) return []

  const capturedCharges: any[] = []
  const maxPages = 10
  let page = 1

  while (page <= maxPages) {
    const data = await fetchMamoChargesPage(page)

    const charges = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.charges)
        ? data.charges
        : Array.isArray(data)
          ? data
          : []

    for (const charge of charges) {
      const status = getMamoChargeStatus(charge).toLowerCase()
      const chargeLinkId = getMamoChargePaymentLinkId(charge)

      if (status === 'captured' && chargeLinkId === trimmedId) {
        capturedCharges.push(charge)
      }
    }

    const nextPage =
      data?.pagination_meta?.next_page ||
      data?.pagination?.next_page ||
      data?.meta?.next_page ||
      null

    if (!nextPage) break

    const numericNextPage = Number(nextPage)

    if (!Number.isFinite(numericNextPage) || numericNextPage <= page) break

    page = numericNextPage
  }

  return capturedCharges
}

const cleanupProcessedReservations = () => {
  // Prevent duplicate cleanup interval during Next.js dev HMR
  if (jobs.cleanupInterval) return

  jobs.cleanupInterval = setInterval(
    () => {
      jobs.processedReservations.clear()
      jobs.lastCheckedByLink.clear()
      jobs.lastInstallmentActivationKey.clear()
      console.log('Cleared in-memory reservation polling caches')
    },
    60 * 60 * 1000,
  ) // Every hour
}

// Call this function when you start your application
cleanupProcessedReservations()

// Helper function to safely format dates
const safeFormatDate = (date: Date | string): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return dateObj.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const buildUserFromReservation = (reservation: any): User => {
  return {
    name: reservation?.guestName || reservation?.user || 'Guest',
    email: reservation?.guestEmail || '',
  } as unknown as User
}

const sendEmail = async (to: string, subject: string, html: string) => {
  try {
    /*if (!EMAIL_CONFIG.enabled) {
      console.warn('Email disabled. Would have sent to:', to, 'subject:', subject)
      return
    }*/

    if (!String(to || '').trim()) {
      throw new Error(`Email recipient is missing for subject: ${subject}`)
    }

    await sendEmailViaGraph({ to, subject, html })
    console.log(`Email sent successfully via Microsoft Graph to ${to}`)
  } catch (error) {
    console.error('Error sending email via Microsoft Graph:', error)
    throw error
  }
}

const createMamoPaymentLink = async (
  reservation: Reservation,
  boat: Boat,
  user: User,
  installmentInfo?: {
    installmentNumber: number
    totalInstallments: number
  },
): Promise<{ url: string; id: string } | null> => {
  console.log('Attempting to create payment link for reservation:', reservation.id)

  // Format dates safely
  const formatDateSafe = (date: Date | string): string => {
    try {
      const dateObj = typeof date === 'string' ? new Date(date) : date
      return dateObj.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
    } catch (error) {
      console.error('Error formatting date:', error)
      return 'Unknown date'
    }
  }

  // Mock implementation for testing without MAMOPAY_API_KEY or when API fails
  if (!MAMOPAY_CONFIG.apiKey || MAMOPAY_CONFIG.apiKey === 'invalid') {
    console.log('MAMOPAY_API_KEY not found or invalid. Using mock payment link for testing.')

    // Create a mock payment link for testing
    const mockPaymentLink = {
      url: `${MAMOPAY_CONFIG.baseUrl}/pay/mock-${Date.now()}-${reservation.id}`,
      id: `mock-link-${Date.now()}-${reservation.id}`,
    }

    console.log('Mock payment link created:', mockPaymentLink)
    return mockPaymentLink
  }

  try {
    console.log('Making API call to MamoPay...')

    const amount = reservation.totalPrice || 0

    // Prepare custom data
    const customData: any = {
      external_id: reservation.transactionId || reservation.id.toString(),
    }

    if (installmentInfo) {
      customData.installment_number = installmentInfo.installmentNumber
      customData.total_installments = installmentInfo.totalInstallments
    }

    const bookingId = reservation.transactionId || reservation.id

    // Prepare the request body
    const requestBody = {
      title: `Reservation for ${boat.name}`.substring(0, 75),
      description:
        `Booking ${formatDubaiDateTime(reservation.startTime)} to ${formatDubaiDateTime(reservation.endTime)}, ${bookingId}`.substring(
          0,
          75,
        ),
      amount: amount,
      amount_currency: 'AED',
      return_url: `${APP_URLS.frontend}/payment-success`,
      failure_return_url: `${APP_URLS.frontend}/payment-failure`,
      active: true,
      processing_fee_percentage: MAMO_PROCESSING_FEE_PERCENTAGE,
      link_type: 'standalone',
      enable_tabby: false,
      enable_message: false,
      enable_tips: false,
      save_card: 'off',
      enable_customer_details: true,
      enable_quantity: false,
      enable_qr_code: false,
      send_customer_receipt: false,
      hold_and_charge_later: false,
      custom_data: customData,
    }

    console.log('MamoPay request body:', JSON.stringify(requestBody, null, 2))

    const response = await fetch(`${MAMOPAY_CONFIG.baseUrl}/manage_api/v1/links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MAMOPAY_CONFIG.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    })

    console.log('MamoPay API response status:', response.status)

    if (!response.ok) {
      const errorText = await response.text()
      console.error('MamoPay API error:', response.statusText, errorText)

      if (response.status === 401 || response.status === 403) {
        console.error('Authentication failed. Please check your MAMOPAY_API_KEY.')

        // In development, fall back to mock implementation
        if (isDevelopment) {
          console.log('Falling back to mock payment link for development')
          const mockPaymentLink = {
            url: `${MAMOPAY_CONFIG.baseUrl}/pay/mock-${Date.now()}-${reservation.id}`,
            id: `mock-link-${Date.now()}-${reservation.id}`,
          }
          return mockPaymentLink
        }

        throw new Error('MamoPay authentication failed')
      }

      throw new Error(`MamoPay API error: ${response.statusText}`)
    }

    const data = await response.json()
    console.log('MamoPay API response data:', data)
    return { url: data.payment_url || data.url, id: data.id }
  } catch (error) {
    console.error('Failed to create MamoPay payment link:', error)

    // In development, fall back to mock implementation on error
    if (isDevelopment) {
      console.log('Falling back to mock payment link due to error')
      const mockPaymentLink = {
        url: `${MAMOPAY_CONFIG.baseUrl}/pay/mock-${Date.now()}-${reservation.id}`,
        id: `mock-link-${Date.now()}-${reservation.id}`,
      }
      return mockPaymentLink
    }

    return null
  }
}

const deleteMamoPaymentLink = async (paymentLinkId?: string): Promise<boolean> => {
  if (!paymentLinkId) return false

  // Mock links are local/dev only and do not exist in Mamo.
  if (paymentLinkId.startsWith('mock-link-')) {
    console.log(`Skipping Mamo delete for mock payment link ${paymentLinkId}`)
    return true
  }

  if (!MAMOPAY_CONFIG.apiKey || MAMOPAY_CONFIG.apiKey === 'invalid') {
    console.warn(`MAMOPAY_API_KEY missing. Could not delete payment link ${paymentLinkId}`)
    return false
  }

  try {
    const response = await fetch(
      `${MAMOPAY_CONFIG.baseUrl}/manage_api/v1/links/${encodeURIComponent(paymentLinkId)}`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${MAMOPAY_CONFIG.apiKey}`,
        },
      },
    )

    if (response.ok) {
      console.log(`Deleted/deactivated Mamo payment link ${paymentLinkId}`)
      return true
    }

    const text = await response.text().catch(() => '')
    console.error(`Failed to delete Mamo payment link ${paymentLinkId}:`, response.status, text)
    return false
  } catch (error) {
    console.error(`Error deleting Mamo payment link ${paymentLinkId}:`, error)
    return false
  }
}


// Creative email templates
const getCreativeEmailTemplate = (
  status: ReservationStatus,
  boat: Boat,
  user: User,
  reservation: Reservation,
): string => {
  const formattedStartDate = safeFormatDate(reservation.startTime)
  const formattedEndDate = safeFormatDate(reservation.endTime)

  switch (status) {
    case 'pending': {
      /* const start = new Date(reservation.startTime)
      const end = new Date(reservation.endTime)

      const dateStr = start.toLocaleDateString('en-GB')
      const timeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) */

      const start = asDate(reservation.startTime)
      const end = asDate(reservation.endTime)

      const dateStr = formatDubaiDate(start)
      const timeStr = formatDubaiTime(start)

      const diffMs = end.getTime() - start.getTime()
      const durationHoursRaw = diffMs > 0 ? diffMs / (1000 * 60 * 60) : 0
      const durationHours =
        Number.isFinite(durationHoursRaw) && durationHoursRaw > 0
          ? (Math.round(durationHoursRaw * 10) / 10).toString().replace(/\.0$/, '')
          : '0'

      const totalPriceNumber =
        typeof reservation.totalPrice === 'number'
          ? reservation.totalPrice
          : Number(reservation.totalPrice || 0)

      const totalPriceStr =
        Number.isFinite(totalPriceNumber) && totalPriceNumber > 0
          ? `AED ${Math.round(totalPriceNumber).toLocaleString()}`
          : 'AED 0'

      const departureLocation =
        (reservation as any)?.departureLocation ||
        (reservation as any)?.location ||
        (boat as any)?.departureLocation ||
        (boat as any)?.location?.name ||
        (boat as any)?.location?.harbour ||
        (boat as any)?.location?.city ||
        (boat as any)?.harbour?.name ||
        'Dubai'

      const requestId = reservation.transactionId || reservation.id

      return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Reservation Request</title>
    </head>
    <body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;padding:32px 16px;">
        <div style="text-align:center;margin-bottom:18px;">
          <img
            src="https://iqs9cmwxvznbiu7f.public.blob.vercel-storage.com/bookthatboat-1.png"
            alt="Book That Boat"
            width="160"
            style="display:inline-block;height:auto;border:0;outline:none;text-decoration:none;"
          />
        </div>
    
        <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 28px rgba(15,23,42,0.10);border:1px solid #e5e7eb;">
          <div style="background:linear-gradient(135deg,#0b5ed7 0%,#0a3d91 100%);padding:22px 18px;text-align:center;">
            <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.85);font-weight:700;">
              Reservation Request Received
            </div>
            <div style="margin-top:10px;display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.22);color:#ffffff;font-size:12px;font-weight:700;">
              Request ID: #${requestId}
            </div>
          </div>
    
          <div style="padding:18px 22px 26px 22px;">
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#374151;">
              Dear <strong style="color:#111827;">${reservation.guestName || user.name || 'Customer'}</strong>,
              <br />
              Thank you for choosing Book That Boat! Below are the details of your reservation request:
            </p>
    
            <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                <tr>
                  <td style="width:42%;padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Boat</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${boat.name}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Date</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${dateStr}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Time</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${timeStr}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Duration</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${durationHours} hours</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Departure Location</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${departureLocation}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;color:#111827;font-weight:800;">Total Price</td>
                  <td style="padding:12px 12px;background:#ffffff;color:#0b5ed7;font-weight:900;">${totalPriceStr}</td>
                </tr>
              </table>
            </div>
    
            <div style="margin-top:16px;padding:14px 14px;border-radius:12px;background:#f8fafc;border:1px solid #e5e7eb;">
              <p style="margin:0;font-size:13px;line-height:1.7;color:#374151;">
                Our team is now working on your request and will be in touch shortly.
                If the selected boat is available at the requested date and time, you will receive a payment link to confirm your booking.
                Please note that we are unable to confirm any bookings without payment.
              </p>
            </div>
    
            <p style="margin:16px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              If you have any questions or need any additional extras, please feel free to reach out to our support team on
              <a href="https://api.whatsapp.com/send?phone=97143408933&text=Hi%20Book%20That%20Boat!%20Can%20you%20help%20me%20with%20my%20payment%20link?" style="color:#0b5ed7;text-decoration:none;font-weight:700;">WhatsApp by clicking here</a>.
              We’re here to help!
            </p>
    
            <p style="margin:16px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              We look forward to providing you with an amazing experience.
            </p>
    
            <p style="margin:18px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              Best regards,<br />
              <strong style="color:#111827;">The Booking Team @ Book That Boat</strong>
            </p>
          </div>
        </div>
    
        <div style="text-align:center;margin-top:18px;color:#6b7280;font-size:12px;line-height:1.6;">
          <div>© ${new Date().getFullYear()} Book That Boat. All rights reserved.</div>
          <div style="margin-top:6px;">
            <a href="https://bookthatboat.com/privacy-policy" style="color:#6b7280;text-decoration:underline;">Privacy Policy</a>
            &nbsp;|&nbsp;
            <a href="https://bookthatboat.com/terms-and-conditions" style="color:#6b7280;text-decoration:underline;">Terms &amp; Conditions</a>
          </div>
        </div>
      </div>
    </body>
    </html>
    `
    }
    case 'confirmed': {
      /* const start = new Date(reservation.startTime)
      const end = new Date(reservation.endTime)

      const dateStr = start.toLocaleDateString('en-GB')
      const timeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) */

      const start = asDate(reservation.startTime)
      const end = asDate(reservation.endTime)

      const dateStr = formatDubaiDate(start)
      const timeStr = formatDubaiTime(start)

      const diffMs = end.getTime() - start.getTime()
      const durationHoursRaw = diffMs > 0 ? diffMs / (1000 * 60 * 60) : 0
      const durationHours =
        Number.isFinite(durationHoursRaw) && durationHoursRaw > 0
          ? (Math.round(durationHoursRaw * 10) / 10).toString().replace(/\.0$/, '')
          : '0'

      const totalPriceNumber =
        typeof reservation.totalPrice === 'number'
          ? reservation.totalPrice
          : Number(reservation.totalPrice || 0)

      const totalPriceStr =
        Number.isFinite(totalPriceNumber) && totalPriceNumber > 0
          ? `AED ${Math.round(totalPriceNumber).toLocaleString()}`
          : 'AED 0'

      const departureLocation =
        (reservation as any)?.departureLocation ||
        (reservation as any)?.location ||
        (boat as any)?.departureLocation ||
        (boat as any)?.location?.name ||
        (boat as any)?.location?.harbour ||
        (boat as any)?.location?.city ||
        (boat as any)?.harbour?.name ||
        'Dubai'

      const bookingId = reservation.transactionId || reservation.id

      // Optional (safe) meeting/parking links if your boat has them; otherwise hidden
      const meetingPointName =
        (reservation as any)?.meetingPointName ||
        (boat as any)?.meetingPoint?.name ||
        (boat as any)?.meetingPointName ||
        departureLocation

      const meetingPointLink =
        (reservation as any)?.meetingPointPin ||
        (boat as any)?.meetingPoint?.url ||
        (boat as any)?.meetingPointUrl ||
        (boat as any)?.meetingPointLink ||
        ''

      const contactName =
        (reservation as any)?.contactPersonName ||
        (reservation as any)?.guestName ||
        user.name ||
        'Guest'

      const contactNumber =
        (reservation as any)?.contactPersonNumber || (reservation as any)?.guestPhone || ''

      const parkingName =
        (reservation as any)?.parkingLocationName ||
        (boat as any)?.parking?.name ||
        (boat as any)?.parkingLocation ||
        'Dubai Marina'

      const parkingLink =
        (reservation as any)?.parkingLocationPin ||
        (boat as any)?.parking?.url ||
        (boat as any)?.parkingUrl ||
        (boat as any)?.parkingLink ||
        ''

      return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Booking Confirmed</title>
    </head>
    
    <body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;padding:32px 16px;">
        <div style="text-align:center;margin-bottom:18px;">
          <img
            src="https://iqs9cmwxvznbiu7f.public.blob.vercel-storage.com/bookthatboat-1.png"
            alt="Book That Boat"
            width="160"
            style="display:inline-block;height:auto;border:0;outline:none;text-decoration:none;"
          />
        </div>
    
        <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 28px rgba(15,23,42,0.10);border:1px solid #e5e7eb;">
          <div style="background:linear-gradient(135deg,#16a34a 0%,#15803d 100%);padding:22px 18px;text-align:center;">
            <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.85);font-weight:700;">
              Booking Confirmed
            </div>
            <div style="margin-top:10px;display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.22);color:#ffffff;font-size:12px;font-weight:700;">
              Booking #${bookingId}
            </div>
          </div>
    
          <div style="padding:18px 22px 26px 22px;">
            <h1 style="margin:0 0 10px 0;font-size:20px;line-height:1.25;font-weight:900;color:#111827;">
              Booking #${bookingId} is confirmed
            </h1>
    
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#374151;">
              Dear <strong style="color:#111827;">${reservation.guestName || user.name || 'Customer'}</strong>,
              <br />
              Your booking is now confirmed. Please carefully read the charter details and pre-departure instructions below.
            </p>
    
            <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                <tr>
                  <td style="width:42%;padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Boat</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${boat.name}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Date</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${dateStr}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Time</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${timeStr}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Duration</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${durationHours} hours</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Departure Location</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${departureLocation}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;color:#111827;font-weight:800;">Total Price</td>
                  <td style="padding:12px 12px;background:#ffffff;color:#16a34a;font-weight:900;">${totalPriceStr}</td>
                </tr>
              </table>
            </div>
    
            <div style="margin-top:16px;">
              <div style="font-size:13px;font-weight:900;color:#111827;margin:0 0 6px 0;">Meeting Point</div>
              <div style="font-size:13px;line-height:1.7;color:#374151;">
                ${meetingPointName}
                ${
                  meetingPointLink
                    ? `<div><a href="${meetingPointLink}" style="color:#0b5ed7;text-decoration:underline;font-weight:700;">Open location</a></div>`
                    : ``
                }
              </div>
            </div>
    
            <div style="margin-top:14px;">
              <div style="font-size:13px;font-weight:900;color:#111827;margin:0 0 6px 0;">Contact Person</div>
              <div style="font-size:13px;line-height:1.7;color:#374151;">
                ${contactName}<br/>
                ${contactNumber}
              </div>
            </div>
    
            <div style="margin-top:14px;">
              <div style="font-size:13px;font-weight:900;color:#111827;margin:0 0 6px 0;">Car Parking Location</div>
              <div style="font-size:13px;line-height:1.7;color:#374151;">
                ${parkingName}
                ${
                  parkingLink
                    ? `<div><a href="${parkingLink}" style="color:#0b5ed7;text-decoration:underline;font-weight:700;">Open location</a></div>`
                    : ``
                }
              </div>
            </div>
    
            <div style="margin-top:16px;padding:14px 14px;border-radius:12px;background:#f8fafc;border:1px solid #e5e7eb;">
              <div style="font-size:13px;font-weight:900;color:#111827;margin:0 0 8px 0;">Important Notes</div>
              <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:#374151;">
                <li>Charter includes a sound system with Bluetooth, towels, water, ice, soft drinks, and plates & cups.</li>
                <li>All passengers must carry their local ID or original passport to comply with UAE Maritime Law.</li>
                <li>Footwear is not permitted to be worn on board during your charter.</li>
                <li>Pets are not permitted on board.</li>
                <li>Boarding will open 10 minutes before your scheduled charter time.</li>
                <li>Children under the age of 12 must always wear a life vest on board.</li>
                <li>Parking is available nearby; charges may apply depending on location.</li>
              </ul>
            </div>
    
            <div style="margin-top:16px;padding:14px 14px;border-radius:12px;background:#f8fafc;border:1px solid #e5e7eb;">
              <div style="font-size:13px;font-weight:900;color:#111827;margin:0 0 8px 0;">Cancellation Policy</div>
              <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:#374151;">
                <li>No-Quibble Refund: Cancellations made within 24 hours of booking are eligible for a full refund (if the booking date is at least 72 hours away).</li>
                <li>After 24 Hours: Cancellations submitted more than 24 hours but less than 72 hours prior are eligible for a 50% refund.</li>
                <li>Cancellations made within 24 hours of the scheduled trip are non-refundable.</li>
                <li>Exceptional Circumstances: In cases of severe weather or operational issues, rescheduling or refunds may be granted according to boat owner policies.</li>
              </ul>
            </div>
    
            <div style="margin-top:16px;padding:14px 14px;border-radius:12px;background:#f8fafc;border:1px solid #e5e7eb;">
              <div style="font-size:13px;font-weight:900;color:#111827;margin:0 0 8px 0;">Late Arrival Policy</div>
              <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:#374151;">
                <li>Please arrive at least 15 minutes before your scheduled time to allow check-in and boarding.</li>
                <li>If guests fail to arrive on time, the booking duration will not be extended and the boat will return as scheduled.</li>
                <li>No compensation for late arrivals; refunds or rescheduling are not provided.</li>
                <li>To maintain schedules and fairness to other customers, exceptions cannot be made.</li>
              </ul>
            </div>
    
            <p style="margin:16px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              If you have any questions, please contact our support team via
              <a href="https://api.whatsapp.com/send?phone=97143408933&text=Hi%20Book%20That%20Boat!%20I%20need%20help%20with%20my%20booking."
                 style="color:#0b5ed7;text-decoration:none;font-weight:700;">WhatsApp by clicking here</a>.
              We’re here to help!
            </p>
    
            <p style="margin:16px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              We look forward to providing you with an amazing experience.
            </p>
    
            <p style="margin:18px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              Best regards,<br />
              <strong style="color:#111827;">The Booking Team @ Book That Boat</strong>
            </p>
          </div>
        </div>
    
        <div style="text-align:center;margin-top:18px;color:#6b7280;font-size:12px;line-height:1.6;">
          <div>© ${new Date().getFullYear()} Book That Boat. All rights reserved.</div>
          <div style="margin-top:6px;">
            <a href="https://bookthatboat.com/privacy-policy" style="color:#6b7280;text-decoration:underline;">Privacy Policy</a>
            &nbsp;|&nbsp;
            <a href="https://bookthatboat.com/terms-and-conditions" style="color:#6b7280;text-decoration:underline;">Terms &amp; Conditions</a>
          </div>
        </div>
      </div>
    </body>
    </html>
    `
    }

    case 'cancelled': {
      /* const start = new Date(reservation.startTime)
      const end = new Date(reservation.endTime)

      const dateStr = start.toLocaleDateString('en-GB')
      const timeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) */

      const start = asDate(reservation.startTime)
      const end = asDate(reservation.endTime)

      const dateStr = formatDubaiDate(start)
      const timeStr = formatDubaiTime(start)

      const diffMs = end.getTime() - start.getTime()
      const durationHoursRaw = diffMs > 0 ? diffMs / (1000 * 60 * 60) : 0
      const durationHours =
        Number.isFinite(durationHoursRaw) && durationHoursRaw > 0
          ? (Math.round(durationHoursRaw * 10) / 10).toString().replace(/\.0$/, '')
          : '0'

      const totalPriceNumber =
        typeof reservation.totalPrice === 'number'
          ? reservation.totalPrice
          : Number(reservation.totalPrice || 0)

      const totalPriceStr =
        Number.isFinite(totalPriceNumber) && totalPriceNumber > 0
          ? `AED ${Math.round(totalPriceNumber).toLocaleString()}`
          : 'AED 0'

      const departureLocation =
        (reservation as any)?.departureLocation ||
        (reservation as any)?.location ||
        (boat as any)?.departureLocation ||
        (boat as any)?.location?.name ||
        (boat as any)?.location?.harbour ||
        (boat as any)?.location?.city ||
        (boat as any)?.harbour?.name ||
        'Dubai'

      const bookingId = reservation.transactionId || reservation.id

      return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Booking Cancelled</title>
    </head>
    
    <body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;padding:32px 16px;">
        <div style="text-align:center;margin-bottom:18px;">
          <img
            src="https://iqs9cmwxvznbiu7f.public.blob.vercel-storage.com/bookthatboat-1.png"
            alt="Book That Boat"
            width="160"
            style="display:inline-block;height:auto;border:0;outline:none;text-decoration:none;"
          />
        </div>
    
        <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 28px rgba(15,23,42,0.10);border:1px solid #e5e7eb;">
          <div style="background:linear-gradient(135deg,#ef4444 0%,#b91c1c 100%);padding:22px 18px;text-align:center;">
            <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.85);font-weight:700;">
              Booking Cancelled
            </div>
            <div style="margin-top:10px;display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.22);color:#ffffff;font-size:12px;font-weight:700;">
              Booking #${bookingId}
            </div>
          </div>
    
          <div style="padding:18px 22px 26px 22px;">
            <h1 style="margin:0 0 10px 0;font-size:20px;line-height:1.25;font-weight:900;color:#111827;">
              Booking #${bookingId} has been cancelled
            </h1>
    
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#374151;">
              Dear <strong style="color:#111827;">${reservation.guestName || user.name || 'Customer'}</strong>,
              <br />
              Your reservation has been cancelled. If this was a mistake or you’d like to reschedule, please contact us and we’ll help you right away.
            </p>
    
            <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                <tr>
                  <td style="width:42%;padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Boat</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${boat.name}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Date</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${dateStr}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Time</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${timeStr}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Duration</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${durationHours} hours</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Departure Location</td>
                  <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${departureLocation}</td>
                </tr>
                <tr>
                  <td style="padding:12px 12px;background:#f3f4f6;color:#111827;font-weight:800;">Total Price</td>
                  <td style="padding:12px 12px;background:#ffffff;color:#ef4444;font-weight:900;">${totalPriceStr}</td>
                </tr>
              </table>
            </div>
    
            <div style="margin-top:16px;padding:14px 14px;border-radius:12px;background:#f8fafc;border:1px solid #e5e7eb;">
              <div style="font-size:13px;font-weight:900;color:#111827;margin:0 0 8px 0;">Cancellation Policy</div>
              <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7;color:#374151;">
                <li>No-Quibble Refund: Cancellations made within 24 hours of booking are eligible for a full refund (if the booking date is at least 72 hours away).</li>
                <li>After 24 Hours: Cancellations submitted more than 24 hours but less than 72 hours prior are eligible for a 50% refund.</li>
                <li>Cancellations made within 24 hours of the scheduled trip are non-refundable.</li>
              </ul>
            </div>
    
            <p style="margin:16px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              Contact our support team via
              <a href="https://api.whatsapp.com/send?phone=97143408933&text=Hi%20Book%20That%20Boat!%20I%20need%20help%20with%20my%20booking."
                 style="color:#0b5ed7;text-decoration:none;font-weight:700;">WhatsApp by clicking here</a>.
            </p>
    
            <p style="margin:18px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              Best regards,<br />
              <strong style="color:#111827;">The Booking Team @ Book That Boat</strong>
            </p>
          </div>
        </div>
    
        <div style="text-align:center;margin-top:18px;color:#6b7280;font-size:12px;line-height:1.6;">
          <div>© ${new Date().getFullYear()} Book That Boat. All rights reserved.</div>
          <div style="margin-top:6px;">
            <a href="https://bookthatboat.com/privacy-policy" style="color:#6b7280;text-decoration:underline;">Privacy Policy</a>
            &nbsp;|&nbsp;
            <a href="https://bookthatboat.com/terms-and-conditions" style="color:#6b7280;text-decoration:underline;">Terms &amp; Conditions</a>
          </div>
        </div>
      </div>
    </body>
    </html>
    `
    }

    case 'awaiting payment': {
      /* const start = new Date(reservation.startTime)
      const end = new Date(reservation.endTime)

      const dateStr = start.toLocaleDateString('en-GB')
      const timeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) */

      const start = asDate(reservation.startTime)
      const end = asDate(reservation.endTime)

      const dateStr = formatDubaiDate(start)
      const timeStr = formatDubaiTime(start)

      const diffMs = end.getTime() - start.getTime()
      const durationHoursRaw = diffMs > 0 ? diffMs / (1000 * 60 * 60) : 0
      const durationHours =
        Number.isFinite(durationHoursRaw) && durationHoursRaw > 0
          ? (Math.round(durationHoursRaw * 10) / 10).toString().replace(/\.0$/, '')
          : '0'

      const totalPriceNumber =
        typeof reservation.totalPrice === 'number'
          ? reservation.totalPrice
          : Number(reservation.totalPrice || 0)

      const totalPriceStr =
        Number.isFinite(totalPriceNumber) && totalPriceNumber > 0
          ? `AED ${Math.round(totalPriceNumber).toLocaleString()}`
          : 'AED 0'

      const departureLocation =
        (reservation as any)?.departureLocation ||
        (reservation as any)?.location ||
        (boat as any)?.departureLocation ||
        (boat as any)?.location?.name ||
        (boat as any)?.location?.harbour ||
        (boat as any)?.location?.city ||
        (boat as any)?.harbour?.name ||
        'Dubai'

      const requestId = reservation.transactionId || reservation.id

      const paymentRequestRow = getPaymentRequestRowForEmail(reservation)
      const firstPaymentRowLink = Array.isArray((reservation as any).payments)
        ? String(
            (reservation as any).payments.find((payment: any) => {
              return String(payment?.method || '').trim() === 'Mamo Pay' && String(payment?.paymentLink || '').trim()
            })?.paymentLink || '',
          ).trim()
        : ''
      const paymentLink = String(
        paymentRequestRow?.paymentLink ||
          firstPaymentRowLink ||
          (reservation as any).paymentLink ||
          '',
      ).trim()
      const paymentRequestAmount = Number(
        paymentRequestRow?.customerPayableAmount ||
          paymentRequestRow?.amount ||
          reservation.totalPrice ||
          0,
      )
      const paymentRequestAmountStr =
        Number.isFinite(paymentRequestAmount) && paymentRequestAmount > 0
          ? `AED ${Math.round(paymentRequestAmount).toLocaleString()}`
          : totalPriceStr

      const bookingTotalNote =
        paymentRequestRow &&
        Math.round(Number(paymentRequestRow.amount || 0)) !== Math.round(totalPriceNumber)
          ? `<tr>
                      <td style="padding:12px 12px;background:#f3f4f6;color:#111827;font-weight:700;">Booking Total</td>
                      <td style="padding:12px 12px;background:#ffffff;color:#111827;font-weight:800;">${totalPriceStr}</td>
                    </tr>`
          : ''

      return `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Payment Required</title>
        </head>
        
        <body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,Helvetica,sans-serif;color:#0f172a;">
          <div style="max-width:640px;margin:0 auto;padding:32px 16px;">
            <div style="text-align:center;margin-bottom:18px;">
              <img
                src="https://iqs9cmwxvznbiu7f.public.blob.vercel-storage.com/bookthatboat-1.png"
                alt="Book That Boat"
                width="160"
                style="display:inline-block;height:auto;border:0;outline:none;text-decoration:none;"
              />
            </div>
        
            <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 28px rgba(15,23,42,0.10);border:1px solid #e5e7eb;">
              <div style="background:linear-gradient(135deg,#ff9800 0%,#ef6c00 100%);padding:22px 18px;text-align:center;">
                <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.88);font-weight:700;">
                  Payment Required to Secure Your Booking
                </div>
                <div style="margin-top:10px;display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.22);color:#ffffff;font-size:12px;font-weight:700;">
                  Request ID: #${requestId}
                </div>
              </div>
        
              <div style="padding:18px 22px 26px 22px;">
                <p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#374151;">
                  Dear <strong style="color:#111827;">${reservation.guestName || user.name || 'Customer'}</strong>,
                  <br />
                  Your reservation is ready — please complete payment to confirm and secure your booking.
                </p>
        
                <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                    <tr>
                      <td style="width:42%;padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Boat</td>
                      <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${boat.name}</td>
                    </tr>
                    <tr>
                      <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Date</td>
                      <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${dateStr}</td>
                    </tr>
                    <tr>
                      <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Time</td>
                      <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${timeStr}</td>
                    </tr>
                    <tr>
                      <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Duration</td>
                      <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${durationHours} hours</td>
                    </tr>
                    <tr>
                      <td style="padding:12px 12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Departure Location</td>
                      <td style="padding:12px 12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${departureLocation}</td>
                    </tr>
                    <tr>
                      <td style="padding:12px 12px;background:#f3f4f6;color:#111827;font-weight:800;">Amount Due</td>
                      <td style="padding:12px 12px;background:#ffffff;color:#ef6c00;font-weight:900;">${paymentRequestAmountStr}</td>
                    </tr>
                    ${bookingTotalNote}
                  </table>
                </div>
        
                <div style="margin-top:16px;padding:14px 14px;border-radius:12px;background:#fff7ed;border:1px solid #fed7aa;">
                  <p style="margin:0;font-size:13px;line-height:1.7;color:#374151;">
                    Please complete your payment using the button below. Once payment is received, your booking will be confirmed immediately.
                  </p>
                </div>
        
                <div style="text-align:center;margin:18px 0 6px 0;">
                  <a
                    href="${paymentLink || '#'}"
                    style="display:inline-block;padding:12px 18px;border-radius:12px;background:#ff9800;color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;"
                  >
                    Complete Payment Now
                  </a>
                </div>
        
                <p style="margin:12px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
                  Need help? Contact us on
                  <a href="https://api.whatsapp.com/send?phone=97143408933&text=Hi%20Book%20That%20Boat!%20Can%20you%20help%20me%20with%20my%20payment%20link?"
                     style="color:#ff9800;text-decoration:none;font-weight:700;">WhatsApp by clicking here</a>.
                </p>
        
                <p style="margin:18px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
                  Best regards,<br />
                  <strong style="color:#111827;">The Booking Team @ Book That Boat</strong>
                </p>
              </div>
            </div>
        
            <div style="text-align:center;margin-top:18px;color:#6b7280;font-size:12px;line-height:1.6;">
              <div>© ${new Date().getFullYear()} Book That Boat. All rights reserved.</div>
              <div style="margin-top:6px;">
                <a href="https://bookthatboat.com/privacy-policy" style="color:#6b7280;text-decoration:underline;">Privacy Policy</a>
                &nbsp;|&nbsp;
                <a href="https://bookthatboat.com/terms-and-conditions" style="color:#6b7280;text-decoration:underline;">Terms &amp; Conditions</a>
              </div>
            </div>
          </div>
        </body>
        </html>
          `
    }

    default:
      return `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <style>
              body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
              .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              .header { background: linear-gradient(135deg, #1e88e5, #0d47a1); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
              .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
              .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="header">
                <h1>Booking Update</h1>
              </div>
              <div class="content">
                <h2>Hello ${reservation.guestName || user.name || 'Valued Customer'},</h2>
                <p>Your booking status for the <strong>${boat.name}</strong> has been updated to: ${status}.</p>
                
                <div style="background: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
                  <h3 style="margin-top: 0;">Reservation Details</h3>
                  <p><strong>Boat:</strong> ${boat.name}</p>
                  <p><strong>Date & Time:</strong> ${formattedStartDate} - ${formattedEndDate}</p>
                  <p><strong>Transaction ID:</strong> ${reservation.transactionId || reservation.id}</p>
                </div>
                
                <p>If you have any questions, please don't hesitate to contact us.</p>
                
                <p>Best regards,<br>The Book That Boat Team</p>
              </div>
              <div class="footer">
                <p>© ${new Date().getFullYear()} Book That Boat. All rights reserved.</p>
              </div>
            </div>
          </body>
          </html>
        `
  }
}


const getBalanceDueEmailTemplate = (
  boat: Boat,
  user: User,
  reservation: Reservation,
): string => {
  const start = asDate(reservation.startTime)
  const end = asDate(reservation.endTime)

  const dateStr = formatDubaiDate(start)
  const timeStr = formatDubaiTime(start)

  const diffMs = end.getTime() - start.getTime()
  const durationHoursRaw = diffMs > 0 ? diffMs / (1000 * 60 * 60) : 0
  const durationHours =
    Number.isFinite(durationHoursRaw) && durationHoursRaw > 0
      ? (Math.round(durationHoursRaw * 10) / 10).toString().replace(/\.0$/, '')
      : '0'

  const payments = Array.isArray(reservation.payments) ? reservation.payments : []
  const totalPrice = Math.max(0, Math.round(Number(reservation.totalPrice || 0)))
  const paidAmount = Math.max(0, Math.round(getCompletedPaidAmount(payments as any)))
  const balanceDue = Math.max(0, Math.round(totalPrice - paidAmount))

  const outstandingPayments = payments.filter((payment) => {
    return payment?.status === 'scheduled' || payment?.status === 'pending'
  })

  const nextDuePayment = outstandingPayments[0]

  const getPaymentMethodLabel = (method?: string) => {
    switch (method) {
      case 'mamo':
      case 'mamopay':
      case 'Mamo Pay':
        return 'Mamo Pay'
      case 'bank_transfer':
      case 'Bank Transfer':
        return 'Bank Transfer'
      case 'cash':
      case 'Cash':
        return 'Cash'
      default:
        return method || 'To be confirmed'
    }
  }

  const getSettlementInstruction = (payment: any) => {
    const method = getPaymentMethodLabel(payment?.method)

    if (method === 'Mamo Pay') {
      if (payment?.paymentLink) {
        return `<a href="${payment.paymentLink}" style="color:#0b5ed7;text-decoration:none;font-weight:800;">Pay securely by Mamo Pay</a>`
      }

      return 'A secure Mamo Pay link will be sent when this payment is due.'
    }

    if (method === 'Bank Transfer') {
      return 'Bank transfer details will be shared by our booking team.'
    }

    if (method === 'Cash') {
      return 'Cash payment to be settled with the Book That Boat team before departure.'
    }

    return 'Our booking team will confirm the settlement details.'
  }

  const nextDueText = nextDuePayment?.date ? safeFormatDate(nextDuePayment.date) : 'To be confirmed'

  const paymentScheduleRows =
    outstandingPayments.length > 0
      ? outstandingPayments
          .map((payment) => {
            const amount = Math.round(Number(payment?.amount || 0)).toLocaleString()
            const dueDate = payment?.date ? safeFormatDate(payment.date) : 'To be confirmed'
            const method = getPaymentMethodLabel(payment?.method)
            const instruction = getSettlementInstruction(payment)

            return `
              <tr>
                <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:800;">AED ${amount}</td>
                <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${dueDate}</td>
                <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${method}</td>
                <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#374151;">${instruction}</td>
              </tr>
            `
          })
          .join('')
      : balanceDue > 0
        ? `
            <tr>
              <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:800;">AED ${balanceDue.toLocaleString()}</td>
              <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">To be confirmed</td>
              <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">To be confirmed</td>
              <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#374151;">Our booking team will confirm the settlement details.</td>
            </tr>
          `
        : `
            <tr>
              <td colspan="4" style="padding:12px;background:#ffffff;color:#374151;text-align:center;">
                No balance remains due.
              </td>
            </tr>
          `

  const departureLocation =
    (reservation as any)?.departureLocation ||
    (reservation as any)?.location ||
    (boat as any)?.departureLocation ||
    (boat as any)?.location?.name ||
    (boat as any)?.location?.harbour ||
    (boat as any)?.location?.city ||
    (boat as any)?.harbour?.name ||
    'Dubai'

  const bookingId = reservation.transactionId || reservation.id

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Booking Confirmed - Balance Due</title>
    </head>
    <body style="margin:0;padding:0;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,Helvetica,sans-serif;color:#0f172a;">
      <div style="max-width:640px;margin:0 auto;padding:32px 16px;">
        <div style="text-align:center;margin-bottom:18px;">
          <img
            src="https://iqs9cmwxvznbiu7f.public.blob.vercel-storage.com/bookthatboat-1.png"
            alt="Book That Boat"
            width="160"
            style="display:inline-block;height:auto;border:0;outline:none;text-decoration:none;"
          />
        </div>

        <div style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 28px rgba(15,23,42,0.10);border:1px solid #e5e7eb;">
          <div style="background:linear-gradient(135deg,#0b5ed7 0%,#0a3d91 100%);padding:22px 18px;text-align:center;">
            <div style="font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.85);font-weight:700;">
              Booking Confirmed - Balance Due
            </div>
            <div style="margin-top:10px;display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.22);color:#ffffff;font-size:12px;font-weight:700;">
              Booking #${bookingId}
            </div>
          </div>

          <div style="padding:18px 22px 26px 22px;">
            <p style="margin:0 0 14px 0;font-size:14px;line-height:1.7;color:#374151;">
              Dear <strong style="color:#111827;">${reservation.guestName || user.name || 'Customer'}</strong>,
              <br />
              Thank you, we have received your payment and your booking is now secured. A balance remains due before your trip.
            </p>

            <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:14px;">
                <tr>
                  <td style="width:42%;padding:12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Boat</td>
                  <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${boat.name}</td>
                </tr>
                <tr>
                  <td style="padding:12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Date</td>
                  <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${dateStr}</td>
                </tr>
                <tr>
                  <td style="padding:12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Time</td>
                  <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${timeStr}</td>
                </tr>
                <tr>
                  <td style="padding:12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Duration</td>
                  <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${durationHours} hours</td>
                </tr>
                <tr>
                  <td style="padding:12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:700;">Departure Location</td>
                  <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;">${departureLocation}</td>
                </tr>
                <tr>
                  <td style="padding:12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:800;">Paid So Far</td>
                  <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#16a34a;font-weight:900;">AED ${Math.round(paidAmount).toLocaleString()}</td>
                </tr>
                <tr>
                  <td style="padding:12px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;font-weight:800;">Balance Due</td>
                  <td style="padding:12px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#ef6c00;font-weight:900;">AED ${balanceDue.toLocaleString()}</td>
                </tr>
                <tr>
                  <td style="padding:12px;background:#f3f4f6;color:#111827;font-weight:800;">Next Due Date</td>
                  <td style="padding:12px;background:#ffffff;color:#111827;font-weight:700;">${nextDueText}</td>
                </tr>
              </table>
            </div>

            <div style="margin-top:18px;">
              <h3 style="margin:0 0 10px 0;font-size:16px;line-height:1.4;color:#111827;">
                Remaining Payment Schedule
              </h3>

              <div style="border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;font-size:13px;">
                  <thead>
                    <tr>
                      <th align="left" style="padding:11px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;">Amount</th>
                      <th align="left" style="padding:11px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;">Due Date</th>
                      <th align="left" style="padding:11px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;">Method</th>
                      <th align="left" style="padding:11px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;color:#111827;">How to Pay</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${paymentScheduleRows}
                  </tbody>
                </table>
              </div>
            </div>

            <div style="margin-top:16px;padding:14px;border-radius:12px;background:#f8fafc;border:1px solid #e5e7eb;">
              <p style="margin:0;font-size:13px;line-height:1.7;color:#374151;">
                Please ensure the remaining balance is settled by the due date shown above and before departure. If a Mamo Pay link is not yet available, our system will send it when that scheduled payment becomes due.
              </p>
            </div>

            <p style="margin:16px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              If you have any questions, please contact our team on
              <a href="https://api.whatsapp.com/send?phone=97143408933&text=Hi%20Book%20That%20Boat!%20I%20need%20help%20with%20my%20booking."
                 style="color:#0b5ed7;text-decoration:none;font-weight:700;">WhatsApp by clicking here</a>.
            </p>

            <p style="margin:18px 0 0 0;font-size:13px;line-height:1.7;color:#374151;">
              Best regards,<br />
              <strong style="color:#111827;">The Booking Team @ Book That Boat</strong>
            </p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `
}


const getStatusEmailContent = (
  recipient: 'user' | 'admin',
  status: ReservationStatus,
  boat: Boat,
  user: User,
  reservation: Reservation,
): string => {
  if (!boat?.name || !reservation.startTime || !reservation.endTime) {
    throw new Error('Missing required email content data')
  }

  if (recipient === 'user') {
    if (status === 'confirmed_balance_due') {
      return getBalanceDueEmailTemplate(boat, user, reservation)
    }

    return getCreativeEmailTemplate(status, boat, user, reservation)
  }

  // Admin email template (simpler version)
  /* const adminContent = `
      <h2>Booking Update - ${status.toUpperCase()}</h2>
      <p>Boat: ${boat.name}</p>
      <p>Guest: ${reservation.guestName || 'No name provided'}</p>
      <p>Guest Email: ${reservation.guestEmail || 'No email provided'}</p>
      <p>Guest Phone: ${reservation.guestPhone || 'No phone provided'}</p>
      <p>Dates: ${safeFormatDate(reservation.startTime)} - ${safeFormatDate(reservation.endTime)}</p>
      <p>Transaction ID: ${reservation.transactionId || reservation.id}</p>
      <p>Payment Status: ${reservation.totalPrice ? 'Paid' : 'Unpaid'}</p>
      ${
        reservation.paymentLink
          ? `<p>Payment Link: <a href="${reservation.paymentLink}">${reservation.paymentLink}</a></p>`
          : ''
      }
    `

  return adminContent */

  const payments = Array.isArray(reservation.payments) ? reservation.payments : []

  const isPaid =
    status === 'confirmed' ||
    (payments.length > 0 && payments.every((p) => p?.status === 'completed'))

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #111827, #374151); color: white; padding: 22px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 22px; border-radius: 0 0 10px 10px; }
        .card { background: white; padding: 16px; border-radius: 8px; margin: 16px 0; }
        .muted { color: #666; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="margin:0;">Booking Update — ${status.toUpperCase()}</h2>
        </div>
        <div class="content">
          <div class="card">
            <p><strong>Boat:</strong> ${boat.name}</p>
            <p><strong>Guest:</strong> ${reservation.guestName || user.name || 'No name provided'}</p>
            <p><strong>Email:</strong> ${reservation.guestEmail || 'No email provided'}</p>
            <p><strong>Phone:</strong> ${reservation.guestPhone || 'No phone provided'}</p>
            <p><strong>Dates:</strong> ${formatDubaiDateTime(reservation.startTime)} - ${formatDubaiDateTime(reservation.endTime)}</p>
            <p><strong>Transaction ID:</strong> ${reservation.transactionId || reservation.id}</p>
            <p><strong>Payment Status:</strong> ${isPaid ? 'Paid' : 'Unpaid'}</p>
            ${
              reservation.paymentLink
                ? `<p><strong>Payment Link:</strong> <a href="${reservation.paymentLink}">${reservation.paymentLink}</a></p>`
                : ''
            }
          </div>
          <p class="muted">Book That Boat — Admin Notification</p>
        </div>
      </div>
    </body>
    </html>
  `
}

const calculateInstallments = (totalAmount: number, numberOfInstallments: number) => {
  const baseAmount = Math.floor(totalAmount / numberOfInstallments)
  const remainder = totalAmount % numberOfInstallments
  const installments = Array(numberOfInstallments).fill(baseAmount)

  // Distribute remainder across installments
  for (let i = 0; i < remainder; i++) {
    installments[i] += 1
  }

  return installments
}

const sendInstallmentReminderEmail = async (
  user: User,
  boat: Boat,
  reservation: Reservation,
  installmentNumber: number,
  totalInstallments: number,
  amount: number,
  paymentLink: string,
  dueDate: string,
) => {
  const subject = `Reminder: Installment ${installmentNumber} of ${totalInstallments} for ${boat.name} is Due`
  const formattedDueDate = safeFormatDate(dueDate)
  const isOverdue = new Date(dueDate) < new Date()

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, ${isOverdue ? '#f44336' : '#ff9800'}, ${isOverdue ? '#c62828' : '#ef6c00'}); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .button { display: inline-block; padding: 12px 24px; background: ${isOverdue ? '#f44336' : '#ff9800'}; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
        .urgent { color: #f44336; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${isOverdue ? 'Overdue Payment' : 'Payment Reminder'}</h1>
        </div>
        <div class="content">
          <h2>Hello ${reservation.guestName || user.name || 'Valued Customer'},</h2>
          <p>This is a reminder that your ${isOverdue ? '<span class="urgent">payment is overdue</span>' : 'payment is due soon'} for installment ${installmentNumber} of ${totalInstallments} for your reservation of the <strong>${boat.name}</strong>.</p>
          
          <div style="background: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Payment Details</h3>
            <p><strong>Boat:</strong> ${boat.name}</p>
            <p><strong>Installment:</strong> ${installmentNumber} of ${totalInstallments}</p>
            <p><strong>Amount Due:</strong> AED ${amount}</p>
            <p><strong>Due Date:</strong> ${formattedDueDate} ${isOverdue ? '<span class="urgent">(OVERDUE)</span>' : ''}</p>
            <p><strong>Transaction ID:</strong> ${reservation.transactionId || reservation.id}</p>
          </div>
          
          <p>Please use the button below to complete your payment:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${paymentLink}" class="button">Pay Installment Now</a>
          </div>
          
          ${isOverdue ? '<p class="urgent">Please note that overdue payments may result in cancellation of your reservation.</p>' : ''}
          
          <p>If you have already made this payment, please disregard this reminder.</p>
          
          <p>If you have any questions, please don't hesitate to contact us.</p>
          
          <p>Best regards,<br>The Book That Boat Team</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} Book That Boat. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `

  if (user.email) {
    await sendEmail(user.email, subject, html)
  }

  // Also send to admin
  await sendEmail(
    EMAIL_CONFIG.adminEmail,
    `[Admin] ${isOverdue ? 'Overdue' : 'Due'} Installment Reminder: ${reservation.transactionId || reservation.id}`,
    `
      <h2>Installment Payment ${isOverdue ? 'Overdue' : 'Reminder'}</h2>
      <p>Reservation: ${reservation.transactionId || reservation.id}</p>
      <p>Customer: ${reservation.guestName || user.name || 'No name'}</p>
      <p>Installment: ${installmentNumber} of ${totalInstallments}</p>
      <p>Amount: AED ${amount}</p>
      <p>Due Date: ${formattedDueDate} ${isOverdue ? '(OVERDUE)' : ''}</p>
      <p>Payment Link: <a href="${paymentLink}">View Payment Link</a></p>
      <p>Customer Email: ${user.email || 'No email'}</p>
      <p>Customer Phone: ${reservation.guestPhone || 'No phone'}</p>
    `,
  )
}

const ACTIVE_PENDING_PAYMENT_STATUSES = new Set(['pending'])

const getCompletedPaidAmount = (payments: Reservation['payments'] | undefined): number => {
  if (!Array.isArray(payments)) return 0

  return payments.reduce((sum, payment) => {
    if (payment?.status !== 'completed') return sum
    return sum + Number(payment.amount || 0)
  }, 0)
}

const getActivePendingPayments = (payments: Reservation['payments'] | undefined) => {
  if (!Array.isArray(payments)) return []

  return payments.filter((payment) => ACTIVE_PENDING_PAYMENT_STATUSES.has(payment?.status || ''))
}

const getActivePendingAmount = (payments: Reservation['payments'] | undefined): number => {
  return getActivePendingPayments(payments).reduce((sum, payment) => {
    return sum + Number(payment.amount || 0)
  }, 0)
}

const getDefaultBalanceDueDate = (reservation: Reservation): string => {
  const start = new Date(reservation.startTime)
  const now = new Date()

  if (Number.isNaN(start.getTime())) {
    return now.toISOString()
  }

  const due = new Date(start)
  due.setHours(due.getHours() - 72)

  if (due < now) {
    return now.toISOString()
  }

  return due.toISOString()
}

const getPaymentKindForOutstanding = ({
  paidAmount,
  paymentMethod,
}: {
  paidAmount: number
  paymentMethod?: Reservation['paymentMethod']
}): PaymentKind => {
  if (paidAmount > 0) return 'balance'
  if (paymentMethod === 'deposit_balance') return 'downpayment'
  return 'full'
}

const createPaymentRowForOutstanding = async ({
  doc,
  req,
  amount,
  paidAmount,
  method,
  notes,
}: {
  doc: Reservation
  req: any
  amount: number
  paidAmount: number
  method: Reservation['method']
  notes: string
}) => {
  const now = new Date().toISOString()
  const kind = getPaymentKindForOutstanding({
    paidAmount,
    paymentMethod: doc.paymentMethod,
  })

  const basePayment = {
    id: `${kind}-${Date.now()}`,
    kind,
    installmentStage:
      method === 'Mamo Pay'
        ? ('installed_ready_to_be_paid' as InstallmentStage)
        : ('ready_to_be_installed' as InstallmentStage),
    createdAt: now,
    installedAt: method === 'Mamo Pay' ? now : '',
    paidAt: '',
    amount,
    method: method || 'Mamo Pay',
    date: now,
    status: 'pending' as PaymentStatus,
    balance: 0,
    paymentLink: '',
    paymentLinkId: '',
    notes,
  }

  if (method !== 'Mamo Pay') {
    return basePayment
  }

  const reservationStatus = String(doc.status || '')

  // Pending reservations are still being prepared by the admin.
  // Do not create/send Mamo Pay links until the payment request workflow starts.
  if (!ACTIVE_RESERVATION_PAYMENT_STATUSES.includes(reservationStatus as any)) {
    return {
      ...basePayment,
      notes: `${notes || ''}${notes ? '\n' : ''}Mamo Pay link will be generated when the reservation is moved to Awaiting Payment.`,
    }
  }

  const boatId = typeof doc.boat === 'object' ? doc.boat.id : doc.boat

  if (!boatId) {
    return basePayment
  }

  const boat = (await req.payload.findByID({
    collection: 'boats',
    id: boatId,
    depth: 2,
    overrideAccess: true,
  })) as unknown as Boat

  const user = {
    name: doc.guestName || (typeof doc.user === 'string' ? doc.user : '') || 'Guest',
    email: doc.guestEmail || '',
  } as unknown as User

  const paymentReservation = {
    ...doc,
    totalPrice: amount,
  } as Reservation

  const paymentLink = await createMamoPaymentLink(paymentReservation, boat, user)

  if (!paymentLink) {
    console.warn(`Payment link was not created for reservation ${doc.id}`)
    return basePayment
  }

  return {
    ...basePayment,
    paymentLink: paymentLink.url,
    paymentLinkId: paymentLink.id,
  }
}

const supersedeActivePendingPayments = async ({
  payments,
  reason,
}: {
  payments: NonNullable<Reservation['payments']>
  reason: string
}) => {
  const now = new Date().toISOString()
  const superseded: NonNullable<Reservation['payments']> = []

  for (const payment of payments) {
    if (!ACTIVE_PENDING_PAYMENT_STATUSES.has(payment?.status || '')) {
      superseded.push(payment)
      continue
    }

    if (payment.method === 'Mamo Pay' && payment.paymentLinkId) {
      await deleteMamoPaymentLink(payment.paymentLinkId)
    }

    superseded.push({
      ...payment,
      status: 'superseded' as PaymentStatus,
      notes: `${payment.notes || ''}${payment.notes ? '\n' : ''}Superseded ${now}: ${reason}`,
    })
  }

  return superseded
}

const isPaymentActiveForSchedule = (payment: any) => {
  return ['scheduled', 'pending', 'completed'].includes(payment?.status)
}

const hasManagedPaymentSchedule = (payments: any[] | undefined) => {
  if (!Array.isArray(payments)) return false

  const activeRows = payments.filter(isPaymentActiveForSchedule)
  if (activeRows.length > 1) return true

  return payments.some((payment) => {
    const status = payment?.status
    const kind = payment?.kind

    return (
      status === 'scheduled' ||
      kind === 'downpayment' ||
      kind === 'installment' ||
      kind === 'balance'
    )
  })
}

const shouldSupersedePendingMamoRowForManualPayment = ({
  payment,
  manualBaseAmount,
  amountRemainingToCover,
}: {
  payment: any
  manualBaseAmount: number
  amountRemainingToCover: number
}) => {
  const status = String(payment?.status || '')
  const method = String(payment?.method || '')

  if (!['scheduled', 'pending'].includes(status)) return false
  if (method !== 'Mamo Pay') return false

  const amount = Math.max(0, Math.round(Number(payment?.amount || 0)))
  if (amount <= 0) return false

  // Real bookings can differ slightly because the Mamo gross amount is reverse-calculated
  // and old schedule rows may have been AED 249 while the captured base is AED 250.
  const tolerance = 2

  return amount <= amountRemainingToCover + tolerance || Math.abs(amount - manualBaseAmount) <= tolerance
}


const getPaymentMethodForSchedule = (payments: any[] | undefined) => {
  return hasManagedPaymentSchedule(payments) ? 'scheduled' : 'full'
}

const isPaymentReceived = (payment: any) => {
  return payment?.status === 'completed'
}

const isPaymentPendingOrScheduled = (payment: any) => {
  return payment?.status === 'scheduled' || payment?.status === 'pending'
}

const normaliseDateOnlyToIso = (value: unknown): string => {
  if (!value) return ''

  const raw = String(value)

  // date input format: YYYY-MM-DD
  // Store at midday UTC to avoid date shifting in admin time zones.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T12:00:00.000Z`).toISOString()
  }

  const parsed = new Date(raw)

  if (Number.isNaN(parsed.getTime())) return ''

  parsed.setUTCHours(12, 0, 0, 0)
  return parsed.toISOString()
}

const startOfUtcDay = (value: Date) => {
  const copy = new Date(value)
  copy.setUTCHours(0, 0, 0, 0)
  return copy
}


const getAwaitingPaymentValidationMessage = ({
  data,
  originalDoc,
}: {
  data?: any
  originalDoc?: any
}): string | null => {
  const nextStatus = data?.status ?? originalDoc?.status

  if (nextStatus !== 'awaiting payment') return null

  const meetingPointName = String(data?.meetingPointName || originalDoc?.meetingPointName || '').trim()
  const meetingPointPin = String(data?.meetingPointPin || originalDoc?.meetingPointPin || '').trim()
  const contactPersonName = String(data?.contactPersonName || originalDoc?.contactPersonName || '').trim()
  const contactPersonNumber = String(data?.contactPersonNumber || originalDoc?.contactPersonNumber || '').trim()
  const parkingLocationName = String(data?.parkingLocationName || originalDoc?.parkingLocationName || '').trim()
  const parkingLocationPin = String(data?.parkingLocationPin || originalDoc?.parkingLocationPin || '').trim()

  const payments = Array.isArray(data?.payments)
    ? data.payments
    : Array.isArray(originalDoc?.payments)
      ? originalDoc.payments
      : []

  const totalPrice = Number(data?.totalPrice ?? originalDoc?.totalPrice ?? 0)

  const activePayments = payments.filter((payment: any) =>
    ['scheduled', 'pending', 'completed'].includes(payment?.status),
  )

  const activePaymentTotal = activePayments.reduce((sum: number, payment: any) => {
    return sum + Number(payment?.amount || 0)
  }, 0)

  const missing: string[] = []

  if (!meetingPointName) missing.push('Meeting Point - Name')
  if (!meetingPointPin) missing.push('Meeting Point - Google Maps Pin')
  if (!contactPersonName) missing.push('Contact Person - Name')
  if (!contactPersonNumber) missing.push('Contact Person - Number')
  if (!parkingLocationName) missing.push('Car Parking Location - Name')
  if (!parkingLocationPin) missing.push('Car Parking Location - Google Maps Pin')

  if (activePayments.length === 0) {
    missing.push(
      'Payment Schedule Manager - add at least one scheduled, awaiting, or received payment row',
    )
  }

  if (
    totalPrice > 0 &&
    activePayments.length > 0 &&
    Math.round(activePaymentTotal) < Math.round(totalPrice)
  ) {
    missing.push(
      `Payment Schedule Manager - active payment rows must cover the reservation total of AED ${Math.round(
        totalPrice,
      ).toLocaleString()}. Current active payment total is AED ${Math.round(
        activePaymentTotal,
      ).toLocaleString()}`,
    )
  }

  if (!missing.length) return null

  return [
    'Cannot move this reservation to Awaiting Payment yet.',
    '',
    'Please complete:',
    ...missing.map((item) => `- ${item}`),
  ].join('\n')
}

const validateReservationPaymentSchedule = ({
  data,
  originalDoc,
  operation,
  context,
}: {
  data: any
  originalDoc?: any
  operation?: string
  context?: any
}) => {
  const payments = Array.isArray(data?.payments)
    ? data.payments
    : Array.isArray(originalDoc?.payments)
      ? originalDoc.payments
      : []

  if (!Array.isArray(payments) || payments.length === 0) {
    return
  }

  const startTimeValue = data?.startTime || originalDoc?.startTime
  const tripStart = startTimeValue ? startOfUtcDay(new Date(startTimeValue)) : null

  const reservationCreatedAtValue =
    originalDoc?.createdAt || data?.createdAt || new Date().toISOString()

  const reservationCreatedAt = startOfUtcDay(new Date(reservationCreatedAtValue))

  let activeScheduledTotal = 0

  payments.forEach((payment: any, index: number) => {
    const rowNumber = index + 1
    const amount = Number(payment?.amount || 0)

    if (amount <= 0) {
      throw new Error(`Payment row ${rowNumber}: amount must be greater than 0.`)
    }

    if (isPaymentActiveForSchedule(payment)) {
      activeScheduledTotal += amount
    }

    const dueIso = normaliseDateOnlyToIso(payment?.date)
    if (!dueIso) {
      throw new Error(`Payment row ${rowNumber}: due date is required.`)
    }

    payment.date = dueIso

    const dueDate = startOfUtcDay(new Date(dueIso))

    // Scheduled/Awaiting rows must sit inside the booking lifecycle:
    // not before the reservation was created, and not after the trip starts.
    // Received/refunded rows can keep historical received/refund dates, but their scheduled
    // due date should still belong to the reservation lifecycle.
    if (dueDate < reservationCreatedAt) {
      throw new Error(`Payment row ${rowNumber}: scheduled due date cannot be before the reservation was created.`)
    }

    if (tripStart && dueDate > tripStart) {
      throw new Error(`Payment row ${rowNumber}: scheduled due date cannot be after the trip start date.`)
    }
  })

  const reservationDeskFinalTotal = Number(context?.reservationDeskFinalTotal)
  const totalPrice = Number.isFinite(reservationDeskFinalTotal)
    ? reservationDeskFinalTotal
    : Number(data?.totalPrice ?? originalDoc?.totalPrice ?? 0)
  const nextStatus = data?.status || originalDoc?.status

  const mustHaveFullSchedule = ['awaiting payment', 'confirmed_balance_due', 'confirmed'].includes(nextStatus)

  // Manual Mamo PAY-ID reconciliation can legitimately add one partial received
  // payment at a time. Keep row amount/date validation above, but do not require
  // the full reservation total to be covered during this specific endpoint flow.
  const allowPartialPaymentSchedule =
    context?.allowPartialPaymentSchedule === true ||
    context?.skipFullPaymentCoverageValidation === true

  if (
    mustHaveFullSchedule &&
    !allowPartialPaymentSchedule &&
    Math.round(activeScheduledTotal) < Math.round(totalPrice)
  ) {
    throw new Error(
      `Payment schedule does not cover the reservation total. Scheduled/received total is AED ${Math.round(
        activeScheduledTotal,
      ).toLocaleString()}, reservation total is AED ${Math.round(totalPrice).toLocaleString()}.`,
    )
  }

  const isPaymentManagerSave = data?.paymentsUpdateSource === 'payment-manager'

  if (data?.paymentMethod === 'full' && !isPaymentManagerSave) {
    const activeRows = payments.filter(isPaymentActiveForSchedule)

    if (activeRows.length > 1) {
      // Payment Schedule Manager is now the source of truth for reservation payments.
      // Older reservations can still have paymentMethod='full' while carrying multiple
      // active rows, especially after manual payment rows, balance rows, or migrated data.
      //
      // Do not block normal admin/status saves for this mismatch. Blocking here causes
      // Payload Admin to fail with a generic 500/"Something went wrong" when changing status.
      console.warn(
        '[reservation payment schedule] Pay in Full reservation has multiple active payment rows; allowing save because payment schedule is source of truth.',
        {
          activeRows: activeRows.length,
          reservationId: data?.id || originalDoc?.id,
        },
      )
    }
  }
}

const sendScheduledManualPaymentEmail = async ({
  reservation,
  payment,
}: {
  reservation: Reservation
  payment: any
}) => {
  if (!reservation.guestEmail) return

  const subject = `Book That Boat - Payment Due #${reservation.transactionId || reservation.id}`

  const methodText =
    payment.method === 'Bank Transfer'
      ? 'Please arrange the bank transfer using the details provided by the Book That Boat team.'
      : payment.method === 'Cash'
        ? 'Your cash payment is now due. Please coordinate with the Book That Boat team.'
        : 'Your payment is now due.'

  await sendEmail(
    reservation.guestEmail,
    subject,
    `
      <h2>Payment Due</h2>
      <p>Dear ${reservation.guestName || 'Guest'},</p>
      <p>A payment is now due for your Book That Boat reservation.</p>
      <p><strong>Amount:</strong> AED ${Math.round(Number(payment.amount || 0)).toLocaleString()}</p>
      <p><strong>Payment method:</strong> ${payment.method}</p>
      <p>${methodText}</p>
    `,
  )
}


const activatePaymentScheduleForReservation = async ({
  reservation,
  boat,
  user,
  payload,
}: {
  reservation: Reservation
  boat: Boat
  user: User
  payload: any
}) => {
  const now = new Date().toISOString()
  const existingPayments = Array.isArray(reservation.payments) ? [...reservation.payments] : []

  let payments = existingPayments
  let createdFallbackSchedule = false

  if (payments.length === 0) {
    const totalPrice = Number(reservation.totalPrice || 0)

    payments = [
      {
        id: `payment-${Date.now()}`,
        kind: 'full',
        installmentStage:
          reservation.method === 'Mamo Pay'
            ? ('ready_to_be_installed' as InstallmentStage)
            : ('ready_to_be_installed' as InstallmentStage),
        createdAt: now,
        installedAt: '',
        paidAt: '',
        amount: totalPrice,
        method: reservation.method || 'Mamo Pay',
        date: now,
        status: 'pending' as PaymentStatus,
        balance: 0,
        paymentLink: '',
        paymentLinkId: '',
        notes: 'Full payment row created automatically when reservation moved to awaiting payment.',
      },
    ] as NonNullable<Reservation['payments']>

    createdFallbackSchedule = true
  }

  let changed = createdFallbackSchedule
  let latestPaymentLink = ''
  let latestPaymentLinkId = ''
  let firstPaymentLink = ''
  let firstPaymentLinkId = ''

  let activatedFirstScheduledPayment = false

  for (let index = 0; index < payments.length; index++) {
    const payment = payments[index]
    if (!payment) continue

    const status = payment.status || ''
    const method = payment.method || reservation.method || 'Mamo Pay'
    const shouldActivateScheduledPayment = status === 'scheduled' && !activatedFirstScheduledPayment

    // When a Reservation Desk booking moves to Awaiting Payment, payment rows are usually still scheduled.
    // Activate the first scheduled row immediately so the customer email has a real Mamo Pay link.
    if (status !== 'pending' && !shouldActivateScheduledPayment) continue

    if (shouldActivateScheduledPayment) {
      activatedFirstScheduledPayment = true
    }

    if (method === 'Mamo Pay') {
      if (payment.paymentLinkId && payment.paymentLink) {
        latestPaymentLink = payment.paymentLink
        latestPaymentLinkId = payment.paymentLinkId

        if (!firstPaymentLink) {
          firstPaymentLink = payment.paymentLink
          firstPaymentLinkId = payment.paymentLinkId
        }

        continue
      }

      const paymentReservation = {
        ...reservation,
        totalPrice: Number(payment.amount || 0),
      } as Reservation

      const link = await createMamoPaymentLink(paymentReservation, boat, user)

      payments[index] = {
        ...payment,
        method: 'Mamo Pay',
        status: 'pending',
        installmentStage: 'installed_ready_to_be_paid' as InstallmentStage,
        installedAt: payment.installedAt || now,
        paymentLink: link?.url || payment.paymentLink || '',
        paymentLinkId: link?.id || payment.paymentLinkId || '',
        notes: `${payment.notes || ''}${payment.notes ? '\n' : ''}Mamo Pay link created when reservation moved to awaiting payment.`,
      }

      latestPaymentLink = link?.url || latestPaymentLink
      latestPaymentLinkId = link?.id || latestPaymentLinkId

      if (!firstPaymentLink && link?.url) {
        firstPaymentLink = link.url
        firstPaymentLinkId = link.id || ''
      }

      changed = true
      continue
    }

    // Manual payment methods: keep the row pending and send instruction email.
    payments[index] = {
      ...payment,
      method,
      status: 'pending',
      installedAt: payment.installedAt || now,
      notes: `${payment.notes || ''}${payment.notes ? '\n' : ''}Manual payment request activated when reservation moved to awaiting payment.`,
    }

    await sendScheduledManualPaymentEmail({
      reservation,
      payment: payments[index],
    })

    changed = true
  }

  if (changed) {
    await withWriteConflictRetry(() =>
      payload.update({
        collection: 'reservations',
        id: reservation.id,
        data: {
          payments,
          paymentsUpdateSource: 'payment-manager',
          paymentLink: firstPaymentLink || latestPaymentLink || '',
          paymentLinkId: firstPaymentLinkId || latestPaymentLinkId || '',
        } as any,
        overrideAccess: true,
        context: {
          paymentsUpdateSource: 'payment-manager',
          skipPaymentReconciliation: true,
          skipBalancePaymentLink: true,
        },
      }),
    )
  }

  return {
    payments,
    paymentLink: firstPaymentLink || latestPaymentLink || '',
    paymentLinkId: firstPaymentLinkId || latestPaymentLinkId || '',
  }
}


const activateDueScheduledPayments = async (payload: any) => {
  try {
    const now = new Date()
    const today = startOfUtcDay(now)

    const reservations = await payload.find({
      collection: 'reservations',
      where: {
        'payments.status': {
          equals: 'scheduled',
        },
      },
      depth: 2,
      limit: 100,
      overrideAccess: true,
    })

    for (const reservation of reservations.docs as Reservation[]) {
      const payments = Array.isArray(reservation.payments) ? [...reservation.payments] : []
      let changed = false
      let latestPaymentLink = ''
      let latestPaymentLinkId = ''

      const boatId = typeof reservation.boat === 'object' ? reservation.boat.id : reservation.boat
      let boat: Boat | null = null

      for (let index = 0; index < payments.length; index++) {
        const payment = payments[index]

        const status = payment?.status || ''
        const method = payment?.method || 'Mamo Pay'
        const hasMamoLink = Boolean(payment?.paymentLinkId || payment?.paymentLink)

        const dueDate = payment.date ? startOfUtcDay(new Date(payment.date)) : null
        const isDue =
          dueDate &&
          !Number.isNaN(dueDate.getTime()) &&
          dueDate <= today

        const shouldActivateScheduledRow = status === 'scheduled' && isDue
        const shouldCreateMissingPendingMamoLink =
          status === 'pending' &&
          method === 'Mamo Pay' &&
          !hasMamoLink

        if (!shouldActivateScheduledRow && !shouldCreateMissingPendingMamoLink) continue

        if (method === 'Mamo Pay') {
          if (!boat && boatId) {
            boat = (await payload.findByID({
              collection: 'boats',
              id: boatId,
              depth: 2,
              overrideAccess: true,
            })) as unknown as Boat
          }

          if (boat) {
            const user = buildUserFromReservation(reservation)

            const paymentReservation = {
              ...reservation,
              totalPrice: Number(payment.amount || 0),
            } as Reservation

            const link = await createMamoPaymentLink(paymentReservation, boat, user)

            payments[index] = {
              ...payment,
              status: 'pending',
              installedAt: now.toISOString(),
              paymentLink: link?.url || payment.paymentLink || '',
              paymentLinkId: link?.id || payment.paymentLinkId || '',
              notes: `${payment.notes || ''}${payment.notes ? '\n' : ''}${
                shouldCreateMissingPendingMamoLink
                  ? 'Missing Mamo Pay link created for awaiting payment row.'
                  : 'Payment link created automatically on due date.'
              }`,
            }

            latestPaymentLink = link?.url || latestPaymentLink
            latestPaymentLinkId = link?.id || latestPaymentLinkId
          }
        } else {
          payments[index] = {
            ...payment,
            status: 'pending',
            installedAt: now.toISOString(),
            notes: `${payment.notes || ''}${payment.notes ? '\n' : ''}Manual payment request activated on due date.`,
          }

          await sendScheduledManualPaymentEmail({
            reservation,
            payment: payments[index],
          })
        }

        changed = true
      }

      if (changed) {
        await withWriteConflictRetry(() =>
          payload.update({
            collection: 'reservations',
            id: reservation.id,
            data: {
              payments,
              paymentsUpdateSource: 'payment-manager',
              ...(latestPaymentLink
                ? {
                    paymentLink: latestPaymentLink,
                    paymentLinkId: latestPaymentLinkId,
                  }
                : {}),
            } as any,
            overrideAccess: true,
            context: {
              paymentsUpdateSource: 'payment-manager',
              skipPaymentReconciliation: true,
              skipBalancePaymentLink: true,
              skipFullPaymentCoverageValidation: true,
              allowPartialPaymentSchedule: true,
            },
          }),
        )
      }
    }
  } catch (error) {
    console.error('Error activating due scheduled payments:', error)
  }
}

const shouldAcceptIncomingPaymentsUpdate = (data?: any, req?: any, context?: any) => {
  if (data?.paymentsUpdateSource === 'payment-manager') {
    return true
  }

  if (context?.paymentsUpdateSource === 'payment-manager') {
    return true
  }

  if (req?.context?.paymentsUpdateSource === 'payment-manager') {
    return true
  }

  const headerSource =
    typeof req?.headers?.get === 'function'
      ? req.headers.get('x-payments-update-source')
      : req?.headers?.['x-payments-update-source']

  const querySource =
    req?.query?.paymentsUpdateSource ||
    req?.searchParams?.get?.('paymentsUpdateSource') ||
    ''

  const requestUrl = String(req?.url || '')

  return (
    headerSource === 'payment-manager' ||
    querySource === 'payment-manager' ||
    requestUrl.includes('paymentsUpdateSource=payment-manager')
  )
}

const preserveExistingPaymentsForNormalReservationSave = async (
  data: any,
  originalDoc?: any,
  req?: any,
  context?: any,
) => {
  const originalPayments = Array.isArray(originalDoc?.payments) ? originalDoc.payments : []
  const isPaymentManagerUpdate = shouldAcceptIncomingPaymentsUpdate(data, req, context)

  // Important:
  // If this is a Payment Schedule Manager save, keep the internal source flag alive
  // through the whole beforeChange hook chain. A later hook also calls this helper.
  // If we strip it too early, the later hook can treat the same request as a normal
  // Payload page save and restore the old payment ledger.
  if (isPaymentManagerUpdate) {
    return data
  }

  const cleanedData = {
    ...data,
    paymentsUpdateSource: undefined,
  }

  // Normal Payload Admin page saves can submit stale or empty payment form state.
  // The Payment Schedule Manager is the only workflow allowed to change payments,
  // so normal reservation saves must preserve the latest payment ledger from the DB,
  // not the potentially stale originalDoc captured when the admin page loaded.
  if (originalDoc?.id && req?.payload?.findByID) {
    try {
      const latestReservation = await req.payload.findByID({
        collection: 'reservations',
        id: originalDoc.id,
        depth: 0,
        overrideAccess: true,
        req,
      })

      const latestPayments = Array.isArray((latestReservation as any)?.payments)
        ? (latestReservation as any).payments
        : []

      return {
        ...cleanedData,
        payments: latestPayments,
      }
    } catch (error) {
      console.warn(
        '[reservations] Failed to fetch latest payments during normal save; falling back to originalDoc payments',
        error,
      )
    }
  }

  return {
    ...cleanedData,
    payments: originalPayments,
  }
}


const normaliseManualPaymentRowsForSave = (data: any, originalDoc?: any) => {
  const payments = Array.isArray(data?.payments)
    ? data.payments
    : Array.isArray(originalDoc?.payments)
      ? originalDoc.payments
      : []

  if (!Array.isArray(payments) || payments.length === 0) {
    return data
  }

  const totalPrice = Math.max(0, Math.round(Number(data?.totalPrice ?? originalDoc?.totalPrice ?? 0)))
  let runningPaidOrPending = 0
  const now = new Date().toISOString()

  data.payments = payments.map((payment: any, index: number) => {
    const amount = Math.max(0, Number(payment?.amount || 0))
    const method = payment?.method || data?.method || originalDoc?.method || 'Mamo Pay'
    const status = payment?.status || 'pending'
    const kind =
      payment?.kind ||
      (status === 'completed'
        ? 'full'
        : method === 'Mamo Pay'
          ? 'full'
          : 'balance')

    const shouldCountAgainstBalance =
      status === 'completed' || status === 'pending'

    if (shouldCountAgainstBalance) {
      runningPaidOrPending += amount
    }

    const nextBalance = Math.max(0, Math.round(totalPrice - runningPaidOrPending))

    const feeFields = getPaymentFeeFields({
      amount,
      method,
    })

    return {
      ...payment,
      id: payment?.id || `${kind}-${Date.now()}-${index}`,
      kind,
      amount,
      method,
      status,
      date: payment?.date || now,
      createdAt: payment?.createdAt || now,
      paidAt:
        status === 'completed' || status === 'refunded'
          ? payment?.paidAt || now
          : payment?.paidAt || '',
      installmentStage:
        status === 'completed'
          ? 'paid'
          : payment?.installmentStage ||
            (method === 'Mamo Pay' ? 'ready_to_be_installed' : 'ready_to_be_installed'),
      balance: nextBalance,
      ...feeFields,
      notes: payment?.notes || '',
    }
  })

  return data
}

const reconcileReservationPaymentsAfterTotalChange = async ({
  doc,
  previousDoc,
  req,
}: {
  doc: Reservation
  previousDoc?: Reservation
  req: any
}) => {
  if ((req as any)?.context?.skipPaymentReconciliation) return doc
  if (!previousDoc) return doc

  const totalPrice = Math.max(0, Math.round(Number(doc.totalPrice || 0)))
  const previousTotalPrice = Math.max(0, Math.round(Number(previousDoc.totalPrice || 0)))

  const currentMethod = doc.method || 'Mamo Pay'
  const previousMethod = previousDoc.method || 'Mamo Pay'
  const methodChanged = currentMethod !== previousMethod
  const totalChanged = totalPrice !== previousTotalPrice

  const existingPayments = Array.isArray(doc.payments) ? [...doc.payments] : []

  if (hasManagedPaymentSchedule(existingPayments)) {
    console.warn(
      '[reservation payment reconciliation] Managed payment schedule detected; skipping automatic replacement with a single full-payment row.',
      {
        reservationId: doc.id,
        paymentRows: existingPayments.length,
        totalPrice,
        previousTotalPrice,
      },
    )

    return doc
  }

  const hasTopLevelPaymentLink = Boolean(doc.paymentLinkId || doc.paymentLink)
  const shouldClearTopLevelMamoLink = currentMethod !== 'Mamo Pay' && hasTopLevelPaymentLink

  const activePendingPayments = getActivePendingPayments(existingPayments)
  const hasActivePendingPayments = activePendingPayments.length > 0

  // Reconcile when either:
  // - the total changes, or
  // - the payment method changes while there is an unpaid active pending payment/link,
  // - or the reservation still has an old top-level Mamo payment link while the current method is Cash/Bank Transfer.
  if (
    !totalChanged &&
    !shouldClearTopLevelMamoLink &&
    (!methodChanged || !hasActivePendingPayments)
  ) {
    return doc
  }

  const paidAmount = getCompletedPaidAmount(existingPayments)
  const activePendingAmount = getActivePendingAmount(existingPayments)
  const outstandingAmount = Math.max(0, Math.round(totalPrice - paidAmount))
  const overpaidAmount = Math.max(0, Math.round(paidAmount - totalPrice))

  const reasonParts: string[] = []

  if (totalChanged) {
    reasonParts.push(`Reservation total changed from AED ${previousTotalPrice} to AED ${totalPrice}.`)
  }

  if (methodChanged) {
    reasonParts.push(`Payment method changed from ${previousMethod} to ${currentMethod}.`)
  }

  if (shouldClearTopLevelMamoLink && !methodChanged) {
    reasonParts.push(`Old top-level Mamo payment link cleared because current method is ${currentMethod}.`)
  }

  const reason = reasonParts.join(' ')

  let updatedPayments = await supersedeActivePendingPayments({
    payments: existingPayments,
    reason,
  })

  let topLevelPaymentLink = ''
  let topLevelPaymentLinkId = ''

  if (shouldClearTopLevelMamoLink) {
    await deleteMamoPaymentLink(doc.paymentLinkId)
  }

  if (outstandingAmount > 0) {
    const method = doc.method || 'Mamo Pay'

    const payment = await createPaymentRowForOutstanding({
      doc,
      req,
      amount: outstandingAmount,
      paidAmount,
      method,
      notes:
        paidAmount > 0
          ? `Outstanding balance after reservation total update. Paid: AED ${paidAmount}. New total: AED ${totalPrice}. Previous pending amount: AED ${activePendingAmount}.`
          : `Replacement payment request after reservation total update. New total: AED ${totalPrice}. Previous pending amount: AED ${activePendingAmount}.`,
    })

    updatedPayments = [...updatedPayments, payment]

    if (payment.method === 'Mamo Pay') {
      topLevelPaymentLink = payment.paymentLink || ''
      topLevelPaymentLinkId = payment.paymentLinkId || ''
    }
  } else if (overpaidAmount > 0) {
    updatedPayments = [
      ...updatedPayments,
      {
        id: `overpaid-${Date.now()}`,
        kind: 'adjustment' as PaymentKind,
        installmentStage: 'paid' as InstallmentStage,
        createdAt: new Date().toISOString(),
        installedAt: '',
        paidAt: '',
        amount: overpaidAmount,
        method: doc.method || 'Mamo Pay',
        date: new Date().toISOString(),
        status: 'pending' as PaymentStatus,
        balance: 0,
        paymentLink: '',
        paymentLinkId: '',
        notes: `Reservation is overpaid by AED ${overpaidAmount}. Manual refund/credit review required.`,
      },
    ]
  }

  await withWriteConflictRetry(() =>
    req.payload.update({
      collection: 'reservations',
      id: doc.id,
      data: {
        payments: updatedPayments,
        paymentLink: topLevelPaymentLink,
        paymentLinkId: topLevelPaymentLinkId,
      },
      overrideAccess: true,
      context: {
        skipPaymentReconciliation: true,
        skipBalancePaymentLink: true,
      },
    }),
  )

  if (topLevelPaymentLink) {
    startPaymentPolling(req.payload)
  }

  return {
    ...doc,
    payments: updatedPayments,
    paymentLink: topLevelPaymentLink,
    paymentLinkId: topLevelPaymentLinkId,
  }
}


const createInstallmentPlan = async (
  reservation: Reservation,
  boat: Boat,
  user: User,
  payload: any,
) => {
  const isDepositBalancePlan = reservation.paymentMethod === 'deposit_balance'

  const numberOfInstallmentsRaw = isDepositBalancePlan
    ? 1
    : Number(reservation.numberOfInstallments ?? 3)

  const numberOfInstallments = Number.isFinite(numberOfInstallmentsRaw)
    ? Math.max(0, Math.floor(numberOfInstallmentsRaw))
    : 3

  const total = Number(reservation.totalPrice || 0)

  // Down payment can be any amount; if not provided, default to an even split across (installments + 1)
  const providedDownPayment = Number(reservation.downPaymentAmount ?? 0)
  const hasProvidedDownPayment = Number.isFinite(providedDownPayment) && providedDownPayment > 0

  let downPaymentAmount = hasProvidedDownPayment
    ? Math.min(providedDownPayment, total)
    : Math.max(1, Math.round(total / (numberOfInstallments + 1)))

  // Guard against edge cases
  if (downPaymentAmount > total) downPaymentAmount = total

  const remaining = Math.max(0, total - downPaymentAmount)

  const installmentAmounts =
    numberOfInstallments > 0 ? calculateInstallments(remaining, numberOfInstallments) : []

  const payments: Reservation['payments'] = []
  const now = new Date()

  // 1) Down payment (link created immediately)
  const downPaymentReservation: Reservation = { ...reservation, totalPrice: downPaymentAmount }
  const downPaymentLink = await createMamoPaymentLink(downPaymentReservation, boat, user, {
    installmentNumber: 1,
    totalInstallments: installmentAmounts.length + 1,
  })

  payments.push({
    id: `downpayment-${Date.now()}`,
    kind: 'downpayment',
    amount: downPaymentAmount,
    method: 'Mamo Pay',
    date: now.toISOString(), // due now
    status: 'pending',
    installmentStage: 'installed_ready_to_be_paid',
    createdAt: now.toISOString(),
    installedAt: now.toISOString(),
    paidAt: '',
    balance: remaining,
    paymentLink: downPaymentLink?.url || '',
    paymentLinkId: downPaymentLink?.id || '',
    notes: `Down payment`,
  } as any)

  // 2) Scheduled installments (NO links yet — activated by scheduler when due)
  let remainingBalance = remaining
  for (let i = 0; i < installmentAmounts.length; i++) {
    const amount = installmentAmounts[i]
    remainingBalance -= amount

    const dueDate = isDepositBalancePlan
      ? new Date(getDefaultBalanceDueDate(reservation))
      : new Date(now)

    if (!isDepositBalancePlan) {
      dueDate.setDate(dueDate.getDate() + (i + 1) * 30) // 30-day intervals
    }

    payments.push({
      id: `${isDepositBalancePlan ? 'balance' : 'installment'}-${i + 1}-${Date.now()}`,
      kind: isDepositBalancePlan ? 'balance' : 'installment',
      amount,
      method: 'Mamo Pay',
      date: dueDate.toISOString(), // scheduled activation date
      status: 'pending',
      installmentStage: 'ready_to_be_installed',
      createdAt: now.toISOString(),
      installedAt: '',
      paidAt: '',
      balance: Math.max(0, remainingBalance),
      paymentLink: '',
      paymentLinkId: '',
      notes: isDepositBalancePlan
        ? 'Balance due before departure'
        : `Installment ${i + 1} of ${installmentAmounts.length}`,
    } as any)
  }

  return payments
}

const sendInstallmentEmail = async (
  user: User,
  boat: Boat,
  reservation: Reservation,
  installmentNumber: number,
  totalInstallments: number,
  amount: number,
  paymentLink: string,
  dueDate: string,
) => {
  const subject = `Payment Request: Installment ${installmentNumber} of ${totalInstallments} for ${boat.name}`
  const formattedDueDate = safeFormatDate(dueDate)

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #1e88e5, #0d47a1); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .button { display: inline-block; padding: 12px 24px; background: #1e88e5; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Installment Payment Request</h1>
        </div>
        <div class="content">
          <h2>Hello ${reservation.guestName || user.name || 'Valued Customer'},</h2>
          <p>This is a payment request for installment ${installmentNumber} of ${totalInstallments} for your reservation of the <strong>${boat.name}</strong>.</p>
          
          <div style="background: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin-top: 0;">Payment Details</h3>
            <p><strong>Boat:</strong> ${boat.name}</p>
            <p><strong>Installment:</strong> ${installmentNumber} of ${totalInstallments}</p>
            <p><strong>Amount Due:</strong> AED ${amount}</p>
            <p><strong>Due Date:</strong> ${formattedDueDate}</p>
          </div>
          
          <p>Please use the button below to complete your payment:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${paymentLink}" class="button">Pay Installment Now</a>
          </div>
          
          <p>If you have any questions, please don't hesitate to contact us.</p>
          
          <p>Best regards,<br>The Book That Boat Team</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} Book That Boat. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `

  if (user.email) {
    await sendEmail(user.email, subject, html)
  }

  // Also send to admin
  await sendEmail(
    EMAIL_CONFIG.adminEmail,
    `[Admin] Installment Payment Request: ${reservation.transactionId || reservation.id}`,
    `
      <h2>Installment Payment Request Created</h2>
      <p>Reservation: ${reservation.transactionId || reservation.id}</p>
      <p>Customer: ${reservation.guestName || user.name || 'No name'}</p>
      <p>Installment: ${installmentNumber} of ${totalInstallments}</p>
      <p>Amount: AED ${amount}</p>
      <p>Due Date: ${formattedDueDate}</p>
      <p>Payment Link: <a href="${paymentLink}">View Payment Link</a></p>
    `,
  )
}

const getRelationshipId = (value: unknown): string | null => {
  if (!value) return null
  if (typeof value === 'string') return value

  if (typeof value === 'object' && 'id' in value) {
    const id = (value as { id?: unknown }).id
    return typeof id === 'string' ? id : null
  }

  return null
}

const getRelationshipIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []

  return value
    .map((item) => getRelationshipId(item))
    .filter(Boolean) as string[]
}

const toSafeNumber = (value: unknown): number => {
  const numberValue = Number(value || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

const getMergedReservationValue = (data: any, originalDoc: any, key: string) => {
  return data?.[key] !== undefined ? data[key] : originalDoc?.[key]
}

const calculateCouponDiscountForReservation = ({
  coupon,
  subtotalBeforeDiscount,
  boatId,
}: {
  coupon: any
  subtotalBeforeDiscount: number
  boatId: string | null
}) => {
  if (!coupon?.id || !coupon?.isActive) return 0

  if (coupon.expiresAt) {
    const expiresAt = new Date(coupon.expiresAt)

    if (!Number.isNaN(expiresAt.getTime()) && expiresAt < new Date()) {
      return 0
    }
  }

  if (!coupon.applyToAllBoats) {
    const allowedBoatIds = getRelationshipIds(coupon.boats)

    if (boatId && allowedBoatIds.length > 0 && !allowedBoatIds.includes(boatId)) {
      return 0
    }
  }

  const amount = toSafeNumber(coupon.amount)

  if (coupon.type === 'percentage') {
    return Math.min(subtotalBeforeDiscount, subtotalBeforeDiscount * (amount / 100))
  }

  if (coupon.type === 'fixed') {
    return Math.min(subtotalBeforeDiscount, amount)
  }

  return 0
}

const calculateReservationTotalForSave = async ({
  req,
  data,
  originalDoc,
}: {
  req: any
  data: any
  originalDoc?: any
}) => {
  const boatValue = getMergedReservationValue(data, originalDoc, 'boat')
  const boatId = getRelationshipId(boatValue)

  const startTimeValue = getMergedReservationValue(data, originalDoc, 'startTime')
  const endTimeValue = getMergedReservationValue(data, originalDoc, 'endTime')

  if (!boatId || !startTimeValue || !endTimeValue) {
    return data
  }

  const startTime = new Date(startTimeValue)
  const endTime = new Date(endTimeValue)

  if (
    Number.isNaN(startTime.getTime()) ||
    Number.isNaN(endTime.getTime()) ||
    endTime <= startTime
  ) {
    data.totalPrice = 0
    return data
  }

  const boat = await req.payload.findByID({
    collection: 'boats',
    id: boatId,
    depth: 0,
    overrideAccess: true,
  })

  const hours = Math.ceil((endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60))
  const hourlyPrice = toSafeNumber(boat?.price)
  const dailyPrice = toSafeNumber(boat?.priceDay)

  let basePrice = 0

  if (hours >= 24) {
    basePrice = Math.ceil(hours / 24) * dailyPrice
  } else {
    basePrice = hours * hourlyPrice
  }

  data.boatHourlyPrice = hourlyPrice
  data.boatDailyPrice = dailyPrice

  const extras = getMergedReservationValue(data, originalDoc, 'extras')
  const otherExtras = getMergedReservationValue(data, originalDoc, 'otherExtras')
  const couponValue = getMergedReservationValue(data, originalDoc, 'coupon')
  const customDiscountAmount = Math.max(
    0,
    toSafeNumber(getMergedReservationValue(data, originalDoc, 'customDiscountAmount')),
  )

  let extrasTotal = 0

  if (Array.isArray(extras)) {
    for (const row of extras) {
      const extraId = getRelationshipId(row?.extra)
      let unitPrice = toSafeNumber(row?.unitPrice)

      if (extraId && unitPrice <= 0) {
        try {
          const extraDoc = await req.payload.findByID({
            collection: 'extras',
            id: extraId,
            depth: 0,
            overrideAccess: true,
          })

          unitPrice = toSafeNumber(extraDoc?.unitPrice)
          row.unitPrice = unitPrice
        } catch {
          // Keep existing row price if the extra cannot be loaded.
        }
      }

      const quantity = Math.max(1, toSafeNumber(row?.quantity) || 1)
      extrasTotal += unitPrice * quantity
    }
  }

  const otherExtrasTotal = Array.isArray(otherExtras)
    ? otherExtras.reduce((sum, row) => {
        const unitPrice = toSafeNumber(row?.price)
        const quantity = Math.max(1, toSafeNumber(row?.quantity) || 1)

        return sum + unitPrice * quantity
      }, 0)
    : 0

  const subtotalBeforeDiscount = basePrice + extrasTotal + otherExtrasTotal

  let couponDiscount = 0
  let couponCode = ''

  const couponId = getRelationshipId(couponValue)

  if (couponId) {
    try {
      const couponDoc = await req.payload.findByID({
        collection: 'coupons',
        id: couponId,
        depth: 1,
        overrideAccess: true,
      })

      couponCode = couponDoc?.code || ''
      couponDiscount = calculateCouponDiscountForReservation({
        coupon: couponDoc,
        subtotalBeforeDiscount,
        boatId,
      })
    } catch {
      couponDiscount = 0
    }
  }

  const customDiscount = Math.min(subtotalBeforeDiscount, customDiscountAmount)
  const totalDiscount = Math.min(subtotalBeforeDiscount, couponDiscount + customDiscount)

  data.totalPrice = Math.max(0, Math.round(subtotalBeforeDiscount - totalDiscount))
  const reservationDeskFinalTotal = Number((req as any)?.context?.reservationDeskFinalTotal)
  if (Number.isFinite(reservationDeskFinalTotal)) {
    data.totalPrice = Math.max(0, Math.round(reservationDeskFinalTotal))
  }

  if (couponCode) {
    data.couponCode = couponCode
  } else if (!couponId) {
    data.couponCode = ''
  }

  return data
}

const updateBoatReservationCount = async ({
  payload,
  boatId,
  req,
}: {
  payload: any
  boatId: string | null
  req?: any
}) => {
  if (!boatId) return

  const result = await payload.find({
    req,
    collection: 'reservations',
    where: {
      boat: {
        equals: boatId,
      },
    },
    depth: 0,
    limit: 0,
    overrideAccess: true,
  })

  await payload.update({
    req,
    collection: 'boats',
    id: boatId,
    data: {
      reservationCount: Number(result.totalDocs || 0),
    },
    overrideAccess: true,
  })
}

const getSavePaymentsErrorDetails = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    message: String(error),
  }
}


const CUSTOMER_MANAGEMENT_CODE_TTL_MINUTES = 15
const CUSTOMER_MANAGEMENT_TOKEN_TTL_HOURS = 2

const getCustomerManagementSecret = () => {
  return (
    process.env.CUSTOMER_MANAGEMENT_SECRET ||
    process.env.PAYLOAD_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    'book-that-boat-customer-management'
  )
}

const hashCustomerManagementValue = (value: string) => {
  return createHash('sha256')
    .update(`${value}:${getCustomerManagementSecret()}`)
    .digest('hex')
}

const safeTokenEquals = (a: string, b: string) => {
  if (!a || !b) return false

  const aBuffer = Buffer.from(a)
  const bBuffer = Buffer.from(b)

  if (aBuffer.length !== bBuffer.length) return false

  return timingSafeEqual(aBuffer, bBuffer)
}

const generateCustomerVerificationCode = () => {
  return String(Math.floor(100000 + Math.random() * 900000))
}

const generateCustomerManagementToken = () => {
  return randomBytes(32).toString('hex')
}

const getManagementExpiryDate = (minutesFromNow: number) => {
  return new Date(Date.now() + minutesFromNow * 60 * 1000).toISOString()
}

const getAdminRefundNotificationEmail = () => {
  return (
    process.env.BOOKING_ADMIN_EMAIL ||
    process.env.RESERVATION_ADMIN_EMAIL ||
    process.env.ADMIN_EMAIL ||
    (EMAIL_CONFIG as any)?.adminEmail ||
    (EMAIL_CONFIG as any)?.to ||
    (EMAIL_CONFIG as any)?.from ||
    'web@bookthatboat.com'
  )
}

const normalizeManageBookingEmail = (value: unknown) => {
  return String(value || '').trim().toLowerCase()
}

const getRequestJsonBody = async (req: any) => {
  if (typeof req.json === 'function') {
    return await req.json().catch(() => null)
  }

  return req.body || null
}

const findReservationForCustomerManagement = async ({
  payload,
  bookingReference,
  guestEmail,
}: {
  payload: any
  bookingReference: string
  guestEmail: string
}) => {
  const cleanBookingReference = String(bookingReference || '').trim()
  const cleanGuestEmail = normalizeManageBookingEmail(guestEmail)

  if (!cleanBookingReference || !cleanGuestEmail) return null

  const result = await payload.find({
    collection: 'reservations',
    where: {
      transactionId: {
        equals: cleanBookingReference,
      },
    },
    limit: 5,
    depth: 1,
    overrideAccess: true,
  })

  const docs = Array.isArray(result?.docs) ? result.docs : []

  return (
    docs.find((reservation: any) => {
      return normalizeManageBookingEmail(reservation?.guestEmail) === cleanGuestEmail
    }) || null
  )
}

const findReservationByManagementToken = async ({
  payload,
  token,
}: {
  payload: any
  token: string
}) => {
  const cleanToken = String(token || '').trim()
  if (!cleanToken) return null

  const tokenHash = hashCustomerManagementValue(cleanToken)

  const result = await payload.find({
    collection: 'reservations',
    where: {
      'customerManagementAuth.managementTokenHash': {
        equals: tokenHash,
      },
    },
    limit: 1,
    depth: 2,
    overrideAccess: true,
  })

  const reservation = Array.isArray(result?.docs) ? result.docs[0] : null
  if (!reservation) return null

  const storedTokenHash = String(reservation?.customerManagementAuth?.managementTokenHash || '')
  const expiresAtRaw = reservation?.customerManagementAuth?.managementTokenExpiresAt
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null

  if (!storedTokenHash || !safeTokenEquals(storedTokenHash, tokenHash)) return null
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) return null

  return reservation
}

const getCustomerReservationSummary = (reservation: any) => {
  const policy = getReservationPolicyResult(reservation)
  const payments = Array.isArray(reservation?.payments) ? reservation.payments : []
  const totalPrice = Number(reservation?.totalPrice || 0)

  const paidAmount = payments.reduce((sum: number, payment: any) => {
    if (payment?.status !== 'completed') return sum
    return sum + Number(payment?.amount || 0)
  }, 0)

  const pendingAmount = payments.reduce((sum: number, payment: any) => {
    if (payment?.status !== 'scheduled' && payment?.status !== 'pending') return sum
    return sum + Number(payment?.amount || 0)
  }, 0)

  const balanceDue = Math.max(0, Math.round(totalPrice - paidAmount))

  const boat = reservation?.boat
  const boatLocation =
    typeof boat === 'object'
      ? boat?.location?.harbour ||
        boat?.location?.name ||
        boat?.location?.title ||
        boat?.location ||
        null
      : null

  return {
    id: reservation?.id,
    bookingReference: reservation?.transactionId,
    status: reservation?.status,
    boat: reservation?.boat,
    guestName: reservation?.user,
    guestEmail: reservation?.guestEmail,
    guestPhone: reservation?.guestPhone,
    countryCode: reservation?.countryCode,
    guests: reservation?.guests,
    startTime: reservation?.startTime,
    endTime: reservation?.endTime,
    totalPrice,
    extras: reservation?.extras || [],
    otherExtras: reservation?.otherExtras || [],
    specialRequests: reservation?.specialRequests || null,
    policy,
    customerCancellation: reservation?.customerCancellation || null,
    tripDetails: {
      location: boatLocation,
      meetingPointName: reservation?.meetingPointName || null,
      meetingPointPin: reservation?.meetingPointPin || null,
      parkingLocation: reservation?.parkingLocation || reservation?.carParkingLocation || null,
      parkingPin: reservation?.parkingPin || reservation?.carParkingPin || null,
      contactName:
        reservation?.bookingContactName ||
        reservation?.captainName ||
        reservation?.contactName ||
        null,
      contactPhone:
        reservation?.bookingContactPhone ||
        reservation?.captainPhone ||
        reservation?.contactPhone ||
        null,
    },
    paymentSummary: {
      totalPrice,
      paidAmount: Math.round(paidAmount),
      pendingAmount: Math.round(pendingAmount),
      balanceDue,
      paymentStatus:
        balanceDue <= 0
          ? 'paid'
          : paidAmount > 0
            ? 'partially_paid'
            : pendingAmount > 0
              ? 'awaiting_payment'
              : 'unpaid',
      payments: payments.map((payment: any) => ({
        id: payment?.id,
        kind: payment?.kind,
        method: payment?.method,
        amount: Number(payment?.amount || 0),
        customerPayableAmount: Number(payment?.customerPayableAmount || payment?.amount || 0),
        status: payment?.status,
        dueDate: payment?.date,
        paidAt: payment?.paidAt,
        paymentLink: payment?.paymentLink || null,
      })),
    },
  }
}

const sendCustomerManagementCodeEmail = async ({
  reservation,
  code,
}: {
  reservation: any
  code: string
}) => {
  const to = String(reservation?.guestEmail || '').trim()
  if (!to) return

  const subject = `Your Book That Boat verification code`

  const bookingId = reservation?.transactionId || reservation?.id || ''
  const guestName = reservation?.user || 'there'
  const boatName =
    typeof reservation?.boat === 'object'
      ? reservation?.boat?.name || reservation?.boat?.title || 'your yacht'
      : 'your yacht'

  const tripDate = reservation?.startTime
    ? formatDubaiDateTime(reservation.startTime)
    : 'Your booking date'

  const html = `
    <div style="margin:0;padding:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f3f7fb;padding:24px 0;">
        <tr>
          <td align="center" style="padding:24px 12px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:680px;background:#ffffff;border-radius:22px;overflow:hidden;box-shadow:0 18px 45px rgba(15,23,42,0.12);">
              <tr>
                <td style="background:linear-gradient(135deg,#07111f 0%,#0b2f57 55%,#0ea5e9 100%);padding:34px 30px;color:#ffffff;">
                  <p style="margin:0 0 10px;font-size:12px;letter-spacing:3px;text-transform:uppercase;color:#bae6fd;font-weight:800;">
                    Book That Boat
                  </p>
                  <h1 style="margin:0;font-size:30px;line-height:1.15;font-weight:900;color:#ffffff;">
                    Manage your booking
                  </h1>
                  <p style="margin:14px 0 0;font-size:15px;line-height:1.7;color:#dbeafe;">
                    Use this verification code to securely access your booking details.
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:30px;">
                  <p style="margin:0 0 14px;font-size:16px;line-height:1.7;color:#111827;">
                    Hello ${guestName},
                  </p>

                  <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:#374151;">
                    Your verification code is:
                  </p>

                  <div style="margin:22px 0;padding:24px;border-radius:18px;background:#eff6ff;border:1px solid #bfdbfe;text-align:center;">
                    <p style="margin:0;font-size:38px;line-height:1;font-weight:900;letter-spacing:8px;color:#0b5ed7;">
                      ${code}
                    </p>
                    <p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:#1e40af;font-weight:700;">
                      This code expires in ${CUSTOMER_MANAGEMENT_CODE_TTL_MINUTES} minutes.
                    </p>
                  </div>

                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:22px 0;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;">
                    <tr>
                      <td style="padding:13px 14px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;">
                        Booking ID
                      </td>
                      <td style="padding:13px 14px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;font-weight:800;text-align:right;">
                        ${bookingId}
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:13px 14px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;">
                        Yacht
                      </td>
                      <td style="padding:13px 14px;background:#ffffff;border-bottom:1px solid #e5e7eb;color:#111827;font-size:14px;font-weight:800;text-align:right;">
                        ${boatName}
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:13px 14px;background:#f8fafc;color:#64748b;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;">
                        Trip
                      </td>
                      <td style="padding:13px 14px;background:#ffffff;color:#111827;font-size:14px;font-weight:800;text-align:right;">
                        ${tripDate}
                      </td>
                    </tr>
                  </table>

                  <div style="margin:22px 0 0;padding:16px 18px;border-radius:16px;background:#fff7ed;border:1px solid #fed7aa;">
                    <p style="margin:0;font-size:14px;line-height:1.7;color:#9a3412;font-weight:700;">
                      If you did not request this code, you can safely ignore this email. Your booking cannot be accessed without this verification code.
                    </p>
                  </div>

                  <p style="margin:26px 0 0;font-size:15px;line-height:1.7;color:#374151;">
                    Warm regards,<br />
                    <strong style="color:#111827;">The Team @ Book That Boat</strong>
                  </p>
                </td>
              </tr>

              <tr>
                <td style="padding:18px 30px;background:#0f172a;color:#cbd5e1;text-align:center;">
                  <p style="margin:0;font-size:12px;line-height:1.6;">
                    Book That Boat · Dubai, UAE
                  </p>
                </td>
              </tr>
            </table>

            <p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#64748b;">
              This is an automated booking security email from Book That Boat.
            </p>
          </td>
        </tr>
      </table>
    </div>
  `

  await sendEmail(to, subject, html)
}

const sendAdminRefundPendingEmail = async ({
  reservation,
  refundAmount,
  refundPercentage,
  cancellationWindow,
  reason,
}: {
  reservation: any
  refundAmount: number
  refundPercentage: number
  cancellationWindow: string
  reason?: string
}) => {
  const adminEmail = getAdminRefundNotificationEmail()
  if (!adminEmail) return

  const subject = `Refund approval required - Booking ${reservation?.transactionId || reservation?.id}`

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827;">
      <h2 style="margin:0 0 12px;color:#b45309;">Customer cancellation - refund approval required</h2>

      <p>A customer has cancelled their booking and a refund is pending admin approval.</p>

      <table style="border-collapse:collapse;width:100%;max-width:720px;">
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">Booking ID</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${reservation?.transactionId || reservation?.id}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">Customer</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${reservation?.user || ''}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">Email</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${reservation?.guestEmail || ''}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">Trip Start</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${reservation?.startTime ? formatDubaiDateTime(reservation.startTime) : 'Unknown'}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">Refund Window</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${cancellationWindow}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">Refund Percentage</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${refundPercentage}%</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">Refund Amount</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">AED ${Math.round(Number(refundAmount || 0)).toLocaleString()}</td>
        </tr>
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;font-weight:700;">Reason</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${reason || 'No reason provided'}</td>
        </tr>
      </table>

      <p style="margin-top:18px;">Please open the reservation in Payload admin and approve or reject the refund.</p>
    </div>
  `

  await sendEmail(adminEmail, subject, html)
}





const getReservationBoatId = (reservation: any): string | null => {
  return getRelationshipId(reservation?.boat)
}

const getBoatForReservation = async ({
  payload,
  reservation,
}: {
  payload: any
  reservation: any
}) => {
  const boat = reservation?.boat

  if (boat && typeof boat === 'object' && boat.id) return boat

  const boatId = getReservationBoatId(reservation)
  if (!boatId) return null

  return payload.findByID({
    collection: 'boats',
    id: boatId,
    depth: 2,
    overrideAccess: true,
  })
}


const isArchivedRecord = (record: any): boolean => {
  return (
    record?.archived === true ||
    record?.isArchived === true ||
    String(record?.status || '').toLowerCase() === 'archived'
  )
}

const getExtraDisplayName = (extra: any): string => {
  return String(extra?.name || extra?.title || extra?.label || 'Extra')
}

const getExtraUnitPrice = (extra: any): number => {
  const raw =
    extra?.price ??
    extra?.unitPrice ??
    extra?.amount ??
    extra?.salePrice ??
    extra?.totalPrice ??
    0

  const value = Number(raw)

  return Number.isFinite(value) && value > 0 ? value : 0
}

const normalizeCustomerExtraQuantity = (value: unknown): number => {
  const quantity = Math.floor(Number(value || 0))

  if (!Number.isFinite(quantity) || quantity < 1) return 1
  if (quantity > 20) return 20

  return quantity
}

const getAvailableExtrasForReservation = async ({
  payload,
  reservation,
}: {
  payload: any
  reservation: any
}) => {
  const boat = await getBoatForReservation({ payload, reservation })
  const boatId = getRelationshipId(boat)

  if (!boat || !boatId) return []

  const extrasMap = new Map<string, any>()

  const addExtra = (extra: any) => {
    if (!extra || typeof extra !== 'object') return
    if (isArchivedRecord(extra)) return

    const id = getRelationshipId(extra)
    if (!id) return

    extrasMap.set(id, extra)
  }

  // 1) Extras linked directly on the boat.
  if (Array.isArray(boat?.extras)) {
    const linkedExtraIds = getRelationshipIds(boat.extras)

    boat.extras.forEach((extra: any) => {
      if (extra && typeof extra === 'object') addExtra(extra)
    })

    if (linkedExtraIds.length > 0) {
      const linkedResult = await payload.find({
        collection: 'extras',
        where: {
          id: {
            in: linkedExtraIds,
          },
        },
        limit: 100,
        depth: 1,
        overrideAccess: true,
      })

      const docs = Array.isArray(linkedResult?.docs) ? linkedResult.docs : []
      docs.forEach(addExtra)
    }
  }

  // 2) Backwards compatibility: extras where the extra owns the boat relationship.
  const byBoatResult = await payload.find({
    collection: 'extras',
    where: {
      boat: {
        equals: boatId,
      },
    },
    limit: 100,
    depth: 1,
    overrideAccess: true,
  }).catch(() => null)

  const byBoatDocs = Array.isArray(byBoatResult?.docs) ? byBoatResult.docs : []
  byBoatDocs.forEach(addExtra)

  return Array.from(extrasMap.values()).map((extra) => ({
    id: String(extra.id),
    name: getExtraDisplayName(extra),
    description: extra.description || extra.shortDescription || '',
    price: getExtraUnitPrice(extra),
    image: extra.image || null,
    raw: extra,
  }))
}

const getCustomerExtrasSummary = (extras: any[]) => {
  return extras.map((extra) => ({
    id: extra.id,
    name: extra.name,
    description: extra.description,
    price: extra.price,
    image: extra.image,
  }))
}


const assertMamoPaymentIdNotAlreadyReconciled = async ({
  payload,
  paymentId,
  reservationId,
  paymentRowId,
}: {
  payload: any
  paymentId: string
  reservationId: string
  paymentRowId?: string
}) => {
  const trimmedPaymentId = String(paymentId || '').trim()

  if (!trimmedPaymentId) return

  const existingReservations = await payload.find({
    collection: 'reservations',
    where: {
      'payments.actualMamoChargeId': {
        equals: trimmedPaymentId,
      },
    },
    depth: 0,
    limit: 10,
    overrideAccess: true,
  })

  const docs = Array.isArray(existingReservations?.docs) ? existingReservations.docs : []

  for (const doc of docs) {
    const payments = Array.isArray((doc as any).payments) ? (doc as any).payments : []

    for (const payment of payments) {
      if (String(payment?.actualMamoChargeId || '').trim() !== trimmedPaymentId) continue

      const sameReservation = String((doc as any).id || '') === String(reservationId || '')
      const samePaymentRow =
        paymentRowId && String(payment?.id || '') === String(paymentRowId || '')

      if (!sameReservation || !samePaymentRow) {
        throw new Error(
          `Mamo PAY-ID ${trimmedPaymentId} is already reconciled against another payment row. A Mamo PAY-ID can only be used once.`,
        )
      }
    }
  }
}

export const Reservations: CollectionConfig = {
  slug: 'reservations',
  endpoints: [
    {
      path: '/:id/payment-state',
      method: 'get',
      handler: async (req) => {
        const routeParams = (req as any).routeParams || {}
        const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id

        try {
          if (!req.user) {
            return Response.json(
              {
                message: 'Unauthorized.',
              },
              {
                status: 401,
              },
            )
          }

          if (!id) {
            return Response.json(
              {
                message: 'Missing reservation ID.',
              },
              {
                status: 400,
              },
            )
          }

          const reservation = await req.payload.findByID({
            collection: 'reservations',
            id,
            depth: 0,
            overrideAccess: true,
          })

          return Response.json({
            doc: {
              id: reservation.id,
              status: (reservation as any).status,
              totalPrice: (reservation as any).totalPrice,
              payments: Array.isArray((reservation as any).payments)
                ? (reservation as any).payments
                : [],
            },
          })
        } catch (error) {
          console.error('[reservation payment-state] failed', {
            reservationId: id,
            error,
          })

          return Response.json(
            {
              message: error instanceof Error ? error.message : 'Could not load reservation payment state.',
            },
            {
              status: 500,
            },
          )
        }
      },
    },

    {
      path: '/:id/manual-mamo-payment',
      method: 'patch',
      handler: async (req) => {
        const routeParams = (req as any).routeParams || {}
        const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id

        try {
          if (!req.user) {
            return Response.json({ message: 'Unauthorized.' }, { status: 401 })
          }

          if (!id) {
            return Response.json({ message: 'Missing reservation ID.' }, { status: 400 })
          }

          const body =
            typeof req.json === 'function'
              ? await req.json().catch(() => null)
              : ((req as any).data || (req as any).body || null)

          const paymentId = String(body?.paymentId || body?.actualMamoChargeId || '').trim()
          const notes = String(body?.notes || '').trim()

          if (!paymentId) {
            return Response.json(
              {
                message:
                  'Enter the unique Mamo PAY-ID / payment reference. The system will fetch the amount and status from Mamo.',
              },
              { status: 400 },
            )
          }

          const reservation = await req.payload.findByID({
            collection: 'reservations',
            id,
            depth: 0,
            overrideAccess: true,
          })

          const payments = Array.isArray((reservation as any).payments)
            ? [...(reservation as any).payments]
            : []

          await assertMamoPaymentIdNotAlreadyReconciled({
            payload: req.payload,
            paymentId,
            reservationId: id,
          })

          const mamoCharge = await getMamoChargeByPaymentId(paymentId)

          if (!mamoCharge) {
            return Response.json(
              {
                message: `Could not find Mamo payment ${paymentId}. Check the PAY-ID and try again.`,
              },
              { status: 404 },
            )
          }

          const fetchedMamoChargeId = getMamoChargeId(mamoCharge) || paymentId
          const fetchedMamoStatus = getMamoChargeStatus(mamoCharge)
          const fetchedMamoStatusLower = fetchedMamoStatus.toLowerCase()

          if (!['captured', 'paid', 'success', 'successful', 'completed'].includes(fetchedMamoStatusLower)) {
            return Response.json(
              {
                message: `Mamo payment ${paymentId} is not captured/paid yet. Current status: ${fetchedMamoStatus || 'unknown'}.`,
              },
              { status: 400 },
            )
          }

          const fetchedGrossAmount = getMamoChargeAmount(mamoCharge)
          const fetchedFee = getMamoChargeFee(mamoCharge)
          const fetchedNetAmount = getMamoChargeNetAmount(mamoCharge)
          const fetchedPaymentLinkId = getMamoChargePaymentLinkId(mamoCharge)
          const fetchedCapturedAt = getMamoChargeCapturedAt(mamoCharge)
          const fetchedCurrency = String(mamoCharge?.currency || mamoCharge?.currency_code || 'AED').trim()
          const now = new Date().toISOString()
          const paidAt = toSafeISOString(fetchedCapturedAt, now)

          if (fetchedGrossAmount <= 0) {
            return Response.json(
              {
                message: `Mamo payment ${paymentId} was found, but no captured amount was returned.`,
              },
              { status: 400 },
            )
          }

          const {
            baseAmount,
            feeAmount,
            customerPayableAmount,
            netAmount,
          } = splitMamoGrossAmount({
            grossAmount: fetchedGrossAmount,
          })

          if (baseAmount <= 0) {
            return Response.json(
              {
                message: `Mamo payment ${paymentId} was found, but the base booking amount could not be calculated.`,
              },
              { status: 400 },
            )
          }

          let amountRemainingToCover = baseAmount
          const supersededIndexes: number[] = []

          const updatedPayments = payments.map((payment: any, index: number) => {
            const amount = Math.max(0, Math.round(Number(payment?.amount || 0)))

            const canSupersede = shouldSupersedePendingMamoRowForManualPayment({
              payment,
              manualBaseAmount: baseAmount,
              amountRemainingToCover,
            })

            if (!canSupersede) {
              return payment
            }

            amountRemainingToCover = Math.max(0, amountRemainingToCover - amount)
            supersededIndexes.push(index)

            return {
              ...payment,
              status: 'superseded',
              installmentStage: payment?.installmentStage || 'paid',
              notes: [
                payment?.notes || '',
                `Superseded by manual Mamo payment ${fetchedMamoChargeId} received on ${paidAt}.`,
              ]
                .filter(Boolean)
                .join('\n'),
            }
          })

          const manualPaymentRow = {
            kind: 'balance',
            amount: baseAmount,
            method: 'Mamo Pay',
            status: 'completed',
            installmentStage: 'paid',
            paidAt,
            dueDate: paidAt,

            paymentLinkId: fetchedPaymentLinkId || '',
            actualPaymentLinkId: fetchedPaymentLinkId || '',
            actualMamoChargeId: fetchedMamoChargeId,
            actualMamoChargeStatus: fetchedMamoStatus,
            actualCapturedAmount: customerPayableAmount,
            actualCapturedFeeAmount: feeAmount,
            actualCapturedNetAmount: netAmount,
            actualCapturedCurrency: fetchedCurrency,
            actualCapturedAt: paidAt,

            processingFeePercentage: MAMO_PROCESSING_FEE_PERCENTAGE,
            processingFeeAmount: feeAmount,
            customerPayableAmount,

            reconciledAt: now,
            reconciledBy:
              typeof req.user === 'object' && req.user
                ? String((req.user as any).id || (req.user as any).email || 'admin')
                : 'admin',
            reconciliationSource: 'manual_admin',
            reconciliationNotes: notes,

            notes: [
              `Manual Mamo payment added by admin from PAY-ID ${fetchedMamoChargeId}.`,
              `Fetched Mamo status: ${fetchedMamoStatus}.`,
              `Fetched Mamo gross/customer-paid amount: ${fetchedCurrency} ${customerPayableAmount}.`,
              `Recorded booking base amount: ${fetchedCurrency} ${baseAmount}.`,
              feeAmount
                ? `Recorded Mamo fee: ${fetchedCurrency} ${feeAmount}.`
                : '',
              notes,
            ]
              .filter(Boolean)
              .join('\n'),
          }

          updatedPayments.push(manualPaymentRow)

          const totalPrice = Math.max(0, Math.round(Number((reservation as any).totalPrice || 0)))

          const paidTotal = updatedPayments.reduce((sum: number, payment: any) => {
            if (payment?.status !== 'completed') return sum
            return sum + Math.max(0, Math.round(Number(payment?.amount || 0)))
          }, 0)

          const currentStatus = String((reservation as any).status || 'pending')
          const balanceDue = Math.max(0, Math.round(totalPrice - paidTotal))
          const isFullyPaid = totalPrice > 0 && Math.round(paidTotal) >= Math.round(totalPrice)

          const updatedDoc = await req.payload.update({
            collection: 'reservations',
            id,
            data: {
              payments: updatedPayments,
              paymentMethod: getPaymentMethodForSchedule(updatedPayments),
              paymentsUpdateSource: 'payment-manager',
            } as any,
            overrideAccess: true,
            context: {
              paymentsUpdateSource: 'payment-manager',
              skipPaymentReconciliation: true,
              skipBalancePaymentLink: true,
              skipFullPaymentCoverageValidation: true,
              allowPartialPaymentSchedule: true,
              skipReservationStatusEmails: true,
              skipCustomerEmails: true,
              skipAdminEmails: true,
              manualPaymentReconciliation: true,
            },
          })

          const savedPayments = Array.isArray((updatedDoc as any).payments)
            ? (updatedDoc as any).payments
            : updatedPayments

          return Response.json({
            doc: updatedDoc,
            savedPayments,
            addedPayment: manualPaymentRow,
            supersededIndexes,
            paidTotal,
            totalPrice,
            balanceDue,
            isFullyPaid,
            status: currentStatus,
            mamoCharge,
          })
        } catch (error) {
          console.error('[manual-mamo-payment] failed', {
            reservationId: id,
            error,
          })

          return Response.json(
            {
              message:
                error instanceof Error
                  ? error.message
                  : 'Could not add manual Mamo payment.',
            },
            { status: 500 },
          )
        }
      },
    },
    {
      path: '/:id/reconcile-payments',
      method: 'patch',
      handler: async (req) => {
        const routeParams = (req as any).routeParams || {}
        const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id

        try {
          if (!req.user) {
            return Response.json({ message: 'Unauthorized.' }, { status: 401 })
          }

          if (!id) {
            return Response.json({ message: 'Missing reservation ID.' }, { status: 400 })
          }

          const body =
            typeof req.json === 'function'
              ? await req.json().catch(() => null)
              : ((req as any).data || (req as any).body || null)

          const allocations = Array.isArray(body?.allocations) ? body.allocations : []

          if (allocations.length === 0) {
            return Response.json(
              {
                message: 'Select at least one payment row to reconcile.',
              },
              { status: 400 },
            )
          }

          const reservation = await req.payload.findByID({
            collection: 'reservations',
            id,
            depth: 0,
            overrideAccess: true,
          })

          const payments = Array.isArray((reservation as any).payments)
            ? [...(reservation as any).payments]
            : []

          if (payments.length === 0) {
            return Response.json(
              { message: 'This reservation has no payment rows to reconcile.' },
              { status: 400 },
            )
          }

          const now = new Date().toISOString()
          const notes = String(body?.notes || '').trim()
          const actualPaymentLink = String(body?.actualPaymentLink || '').trim()
          const actualPaymentLinkId = String(body?.actualPaymentLinkId || '').trim()
          const actualMamoChargeId = String(body?.actualMamoChargeId || '').trim()

          if (!actualMamoChargeId) {
            return Response.json(
              {
                message:
                  'Enter the unique Mamo PAY-ID / payment reference before reconciling. The system will fetch the real amount and status from Mamo.',
              },
              { status: 400 },
            )
          }

          const mamoCharge = await getMamoChargeByPaymentId(actualMamoChargeId)

          if (!mamoCharge) {
            return Response.json(
              {
                message: `Could not find Mamo payment ${actualMamoChargeId}. Check the PAY-ID and try again.`,
              },
              { status: 404 },
            )
          }

          const fetchedMamoChargeId = getMamoChargeId(mamoCharge) || actualMamoChargeId
          const fetchedMamoStatus = getMamoChargeStatus(mamoCharge)
          const fetchedMamoStatusLower = fetchedMamoStatus.toLowerCase()

          if (!['captured', 'paid', 'success', 'successful', 'completed'].includes(fetchedMamoStatusLower)) {
            return Response.json(
              {
                message: `Mamo payment ${actualMamoChargeId} is not captured/paid yet. Current status: ${fetchedMamoStatus || 'unknown'}.`,
              },
              { status: 400 },
            )
          }

          const fetchedAmount = getMamoChargeAmount(mamoCharge)
          const fetchedFee = getMamoChargeFee(mamoCharge)
          const fetchedNetAmount = getMamoChargeNetAmount(mamoCharge)
          const fetchedPaymentLinkId = getMamoChargePaymentLinkId(mamoCharge)
          const fetchedCapturedAt = getMamoChargeCapturedAt(mamoCharge)
          const fetchedCurrency = String(mamoCharge?.currency || mamoCharge?.currency_code || 'AED').trim()

          if (fetchedAmount <= 0) {
            return Response.json(
              {
                message: `Mamo payment ${actualMamoChargeId} was found, but no captured amount was returned.`,
              },
              { status: 400 },
            )
          }

          const capturedTotal = fetchedAmount

          const updatedIndexes: number[] = []

          for (const allocation of allocations) {
            const paymentId = String(allocation?.paymentId || '').trim()
            const rowIndex =
              typeof allocation?.rowIndex === 'number'
                ? allocation.rowIndex
                : Number.isFinite(Number(allocation?.rowIndex))
                  ? Number(allocation.rowIndex)
                  : -1

            const index = paymentId
              ? payments.findIndex((payment: any) => String(payment?.id || '') === paymentId)
              : rowIndex

            if (index < 0 || index >= payments.length || !payments[index]) {
              throw new Error(
                paymentId
                  ? `Could not find payment row with ID ${paymentId}.`
                  : `Could not find payment row at index ${rowIndex}.`,
              )
            }

            const existingPayment = payments[index]
            const rowActualMamoChargeId = fetchedMamoChargeId

            await assertMamoPaymentIdNotAlreadyReconciled({
              payload: req.payload,
              paymentId: rowActualMamoChargeId,
              reservationId: id,
              paymentRowId: existingPayment?.id,
            })

            const paidAt = toSafeISOString(fetchedCapturedAt, now)

            const rowActualPaymentLink = String(
              allocation?.actualPaymentLink ||
                actualPaymentLink ||
                existingPayment?.actualPaymentLink ||
                existingPayment?.paymentLink ||
                '',
            ).trim()

            const rowActualPaymentLinkId = String(
              allocation?.actualPaymentLinkId ||
                actualPaymentLinkId ||
                fetchedPaymentLinkId ||
                existingPayment?.actualPaymentLinkId ||
                existingPayment?.paymentLinkId ||
                '',
            ).trim()

            const existingProcessingFee =
              fetchedFee > 0
                ? fetchedFee
                : Math.round(fetchedAmount * (MAMO_PROCESSING_FEE_PERCENTAGE / 100))

            const existingCustomerPayable =
              fetchedFee > 0
                ? fetchedAmount + fetchedFee
                : fetchedAmount + existingProcessingFee

            const noteParts = [
              existingPayment?.notes || '',
              `Manual reconciliation ${now}: payment row marked as received from fetched Mamo PAY-ID.`,
              `Mamo PAY-ID: ${rowActualMamoChargeId}.`,
              `Fetched Mamo status: ${fetchedMamoStatus}.`,
              `Fetched captured amount: ${fetchedCurrency} ${fetchedAmount}.`,
              fetchedFee > 0
                ? `Fetched Mamo fee: ${fetchedCurrency} ${fetchedFee}.`
                : `Mamo fee was not returned by the API response; recorded calculated ${MAMO_PROCESSING_FEE_PERCENTAGE}% fee as ${fetchedCurrency} ${existingProcessingFee}.`,
              rowActualPaymentLinkId ? `Actual Mamo link ID/reference: ${rowActualPaymentLinkId}.` : '',
              rowActualPaymentLink ? `Actual Mamo payment link: ${rowActualPaymentLink}.` : '',
              notes,
            ].filter(Boolean)

            payments[index] = {
              ...existingPayment,
              amount: fetchedAmount,
              status: 'completed',
              installmentStage: 'paid',
              paidAt,
              method: existingPayment?.method || 'Mamo Pay',

              paymentLink: existingPayment?.paymentLink || rowActualPaymentLink || '',
              paymentLinkId: existingPayment?.paymentLinkId || rowActualPaymentLinkId || '',

              actualPaymentLink: rowActualPaymentLink,
              actualPaymentLinkId: rowActualPaymentLinkId,
              actualMamoChargeId: rowActualMamoChargeId,
              actualMamoChargeStatus: fetchedMamoStatus,
              actualCapturedAmount: fetchedAmount,
              actualCapturedFeeAmount: fetchedFee || existingProcessingFee,
              actualCapturedNetAmount:
                fetchedNetAmount > 0
                  ? fetchedNetAmount
                  : Math.max(0, fetchedAmount - (fetchedFee || existingProcessingFee)),
              actualCapturedCurrency: fetchedCurrency,
              actualCapturedAt: paidAt,
              processingFeePercentage: MAMO_PROCESSING_FEE_PERCENTAGE,
              processingFeeAmount: fetchedFee || existingProcessingFee,
              customerPayableAmount: existingCustomerPayable,
              reconciledAt: now,
              reconciledBy:
                typeof req.user === 'object' && req.user
                  ? String((req.user as any).id || (req.user as any).email || 'admin')
                  : 'admin',
              reconciliationNotes: notes,
              reconciliationSource: 'manual_admin',

              notes: noteParts.join('\\n'),
            }

            updatedIndexes.push(index)
          }

          const totalPrice = Math.max(0, Math.round(Number((reservation as any).totalPrice || 0)))

          const paidTotal = payments.reduce((sum: number, payment: any) => {
            if (payment?.status !== 'completed') return sum
            return sum + Math.max(0, Math.round(Number(payment?.amount || 0)))
          }, 0)

          const currentStatus = String((reservation as any).status || 'pending')
          const balanceDue = Math.max(0, Math.round(totalPrice - paidTotal))
          const isFullyPaid = totalPrice > 0 && Math.round(paidTotal) >= Math.round(totalPrice)

          const updatedDoc = await req.payload.update({
            collection: 'reservations',
            id,
            data: {
              payments,
              paymentsUpdateSource: 'payment-manager',
            } as any,
            overrideAccess: true,
            context: {
              paymentsUpdateSource: 'payment-manager',
              skipPaymentReconciliation: true,
              skipBalancePaymentLink: true,
              skipFullPaymentCoverageValidation: true,
              allowPartialPaymentSchedule: true,
              skipReservationStatusEmails: true,
              skipCustomerEmails: true,
              skipAdminEmails: true,
              manualPaymentReconciliation: true,
            },
          })

          const savedPayments = Array.isArray((updatedDoc as any).payments)
            ? (updatedDoc as any).payments
            : payments

          return Response.json({
            doc: updatedDoc,
            updatedIndexes,
            savedPayments,
            paidTotal,
            totalPrice,
            balanceDue,
            isFullyPaid,
            status: currentStatus,
            mamoCharge,
            capturedTotal,
          })
        } catch (error) {
          console.error('[reconcile-payments] failed', {
            reservationId: id,
            error,
          })

          return Response.json(
            {
              message:
                error instanceof Error
                  ? error.message
                  : 'Could not reconcile payment rows.',
            },
            { status: 500 },
          )
        }
      },
    },
    {
      path: '/:id/save-payments',
      method: 'patch',
      handler: async (req) => {
        const routeParams = (req as any).routeParams || {}
        const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id

        try {
          if (!id) {
            return Response.json(
              {
                message: 'Missing reservation ID.',
              },
              {
                status: 400,
              },
            )
          }

          const body =
            typeof req.json === 'function'
              ? await req.json().catch(() => null)
              : (req as any).body || null

          const rawPayments = Array.isArray(body?.payments) ? body.payments : []
          const normalisedNow = new Date().toISOString()

          const payments = rawPayments.map((payment: any, index: number) => {
            const amount = Math.max(0, Math.round(Number(payment?.amount || 0)))
            const method = payment?.method || 'Mamo Pay'
            const status = payment?.status || 'scheduled'
            const isReceived = status === 'completed'
            const isRefunded = status === 'refunded'

            const feeFields = getPaymentFeeFields({
              amount,
              method,
            })

            return {
              ...payment,
              id: payment?.id || `payment-${Date.now()}-${index}`,
              amount,
              method,
              status,
              paidAt: isReceived || isRefunded ? payment?.paidAt || normalisedNow : '',
              installmentStage: isReceived ? 'paid' : payment?.installmentStage || 'ready_to_be_installed',
              ...feeFields,
            }
          })

          console.info('[save-payments] submitted rows', {
            reservationId: id,
            rows: payments.map((payment: any) => ({
              id: payment?.id,
              amount: payment?.amount,
              method: payment?.method,
              status: payment?.status,
              paidAt: payment?.paidAt,
              installmentStage: payment?.installmentStage,
            })),
          })

          const deletedPaymentKeys = new Set(
            Array.isArray(body?.deletedPaymentKeys)
              ? body.deletedPaymentKeys.map((key: unknown) => String(key || '').trim()).filter(Boolean)
              : [],
          )

          const getPaymentDeleteKey = (payment?: any): string => {
            if (!payment) return ''

            return String(
              payment.id ||
                payment.paymentLinkId ||
                payment.paymentLink ||
                payment.actualMamoChargeId ||
                payment.actualPaymentLinkId ||
                `${payment.amount || 0}:${payment.method || ''}:${payment.status || ''}:${payment.date || ''}:${payment.paidAt || ''}`,
            ).trim()
          }

          const isProtectedPaymentRow = (payment?: any) => {
            if (!payment) return false

            return (
              payment.status === 'completed' ||
              Boolean(payment.actualMamoChargeId) ||
              Boolean(payment.reconciledAt) ||
              Boolean(payment.reconciliationSource)
            )
          }

          const removeDeletedPaymentRows = (rows: any[]) => {
            if (!deletedPaymentKeys.size) return rows

            return rows.filter((payment) => {
              // Received/reconciled rows are accounting records. They must not be
              // removed by a schedule edit, even if a stale mobile UI submits them
              // as deleted. They should be refunded/voided via a separate workflow.
              if (isProtectedPaymentRow(payment)) return true

              const key = getPaymentDeleteKey(payment)
              return !key || !deletedPaymentKeys.has(key)
            })
          }

          const existingReservation = await req.payload.findByID({
            collection: 'reservations',
            id,
            depth: 0,
            overrideAccess: true,
          })

          const existingPayments = Array.isArray((existingReservation as any)?.payments)
            ? (existingReservation as any).payments
            : []

          const submittedPaymentKeys = new Set(payments.map((payment: any) => getPaymentDeleteKey(payment)).filter(Boolean))

          const protectedExistingPaymentsToRestore = existingPayments.filter((payment: any) => {
            if (!isProtectedPaymentRow(payment)) return false

            const key = getPaymentDeleteKey(payment)
            return key && !submittedPaymentKeys.has(key)
          })

          const paymentsToPersist =
            protectedExistingPaymentsToRestore.length > 0
              ? [...payments, ...protectedExistingPaymentsToRestore]
              : payments

          // Payment Schedule Manager saves are explicit admin edits.
          // The submitted rows must be treated as the source of truth; do not run
          // automatic activation/reconciliation afterwards because that can convert
          // Cash/Bank rows marked as Received back to Awaiting Payment.
          const preserveSubmittedPaymentRows = true

          const updatedDoc = await req.payload.update({
            collection: 'reservations',
            id,
            data: {
              payments: paymentsToPersist,
              paymentMethod: getPaymentMethodForSchedule(paymentsToPersist),
              paymentsUpdateSource: 'payment-manager',
            } as any,
            overrideAccess: true,
            context: {
              paymentsUpdateSource: 'payment-manager',
              skipPaymentReconciliation: true,
              skipBalancePaymentLink: true,
              skipFullPaymentCoverageValidation: true,
              allowPartialPaymentSchedule: true,
              preserveSubmittedPaymentRows,
            },
          })

          let responseDoc = updatedDoc
          let savedPayments = Array.isArray((responseDoc as any)?.payments)
            ? removeDeletedPaymentRows((responseDoc as any).payments)
            : []

          if (
            deletedPaymentKeys.size > 0 &&
            Array.isArray((updatedDoc as any)?.payments) &&
            savedPayments.length !== (updatedDoc as any).payments.length
          ) {
            responseDoc = await req.payload.update({
              collection: 'reservations',
              id,
              data: {
                payments: savedPayments,
                paymentMethod: getPaymentMethodForSchedule(savedPayments),
                paymentsUpdateSource: 'payment-manager',
              } as any,
              overrideAccess: true,
              context: {
                paymentsUpdateSource: 'payment-manager',
                skipPaymentReconciliation: true,
                skipBalancePaymentLink: true,
                skipFullPaymentCoverageValidation: true,
                allowPartialPaymentSchedule: true,
                preserveSubmittedPaymentRows: true,
              },
            })

            savedPayments = Array.isArray((responseDoc as any)?.payments)
              ? removeDeletedPaymentRows((responseDoc as any).payments)
              : savedPayments
          }

          if (payments.length > 0 && savedPayments.length === 0) {
            return Response.json(
              {
                message:
                  'Payment rows were submitted but the saved reservation returned zero payment rows.',
                submittedPaymentsCount: payments.length,
                paymentsCount: 0,
                submittedPayments: payments,
              },
              {
                status: 500,
              },
            )
          }

          const now = new Date()
          const today = startOfUtcDay(now)

          const shouldRunPaymentActivation =
            !preserveSubmittedPaymentRows &&
            savedPayments.some((payment: any) => {
              const status = payment?.status || ''
              const method = payment?.method || 'Mamo Pay'
              const hasMamoLink = Boolean(payment?.paymentLinkId || payment?.paymentLink)

              const dueDate = payment.date ? startOfUtcDay(new Date(payment.date)) : null
              const isDue =
                dueDate &&
                !Number.isNaN(dueDate.getTime()) &&
                dueDate <= today

              const isDueScheduledRow = status === 'scheduled' && isDue
              const isPendingMamoRowMissingLink =
                status === 'pending' &&
                method === 'Mamo Pay' &&
                !hasMamoLink

              return isDueScheduledRow || isPendingMamoRowMissingLink
            })

          if (shouldRunPaymentActivation) {
            await activateDueScheduledPayments(req.payload)

            responseDoc = await req.payload.findByID({
              collection: 'reservations',
              id,
              depth: 2,
              overrideAccess: true,
            })

            savedPayments = Array.isArray((responseDoc as any)?.payments)
              ? removeDeletedPaymentRows((responseDoc as any).payments)
              : []
          }

          return Response.json({
            doc: responseDoc,
            submittedPaymentsCount: payments.length,
            deletedPaymentKeys: Array.from(deletedPaymentKeys),
            paymentsCount: savedPayments.length,
            savedPayments,
          })
        } catch (error) {
          const errorDetails = getSavePaymentsErrorDetails(error)

          console.error('[save-payments] failed', {
            reservationId: id,
            error: errorDetails,
          })

          return Response.json(
            {
              message: errorDetails.message || 'Something went wrong.',
              errors: [
                {
                  message: errorDetails.message || 'Something went wrong.',
                },
              ],
              errorDetails,
            },
            {
              status: 500,
            },
          )
        }
      },
    },
    {
    path: '/customer-management/request-code',
    method: 'post',
    handler: async (req) => {
    try {
    const body = await getRequestJsonBody(req)

    const bookingReference = String(body?.bookingReference || body?.transactionId || '').trim()
    const guestEmail = String(body?.guestEmail || body?.email || '').trim()

    const reservation = await findReservationForCustomerManagement({
    payload: req.payload,
    bookingReference,
    guestEmail,
    })

    // Do not reveal which part was wrong.
    if (!reservation) {
    return Response.json({
    success: true,
    message:
    'If the booking details match our records, a verification code will be sent.',
    })
    }

    const code = generateCustomerVerificationCode()
    const verificationCodeHash = hashCustomerManagementValue(code)

    await req.payload.update({
    collection: 'reservations',
    id: reservation.id,
    data: {
    customerManagementAuth: {
    ...(reservation.customerManagementAuth || {}),
    verificationCodeHash,
    verificationCodeExpiresAt: getManagementExpiryDate(CUSTOMER_MANAGEMENT_CODE_TTL_MINUTES),
    },
    } as any,
    overrideAccess: true,
    })

    await sendCustomerManagementCodeEmail({
    reservation,
    code,
    })

    return Response.json({
    success: true,
    message:
    'If the booking details match our records, a verification code will be sent.',
    })
    } catch (error) {
    console.error('[customer-management/request-code] failed', error)

    return Response.json(
    {
    success: false,
    message: 'Could not request booking verification code.',
    },
    {
    status: 500,
    },
    )
    }
    },
    },
    {
    path: '/customer-management/verify-code',
    method: 'post',
    handler: async (req) => {
    try {
    const body = await getRequestJsonBody(req)

    const bookingReference = String(body?.bookingReference || body?.transactionId || '').trim()
    const guestEmail = String(body?.guestEmail || body?.email || '').trim()
    const code = String(body?.code || '').trim()

    if (!bookingReference || !guestEmail || !code) {
    return Response.json(
    {
    success: false,
    message: 'Booking ID, email and verification code are required.',
    },
    {
    status: 400,
    },
    )
    }

    const reservation = await findReservationForCustomerManagement({
    payload: req.payload,
    bookingReference,
    guestEmail,
    })

    if (!reservation) {
    return Response.json(
    {
    success: false,
    message: 'Invalid or expired verification code.',
    },
    {
    status: 401,
    },
    )
    }

    const auth = reservation.customerManagementAuth || {}
    const expiresAt = auth.verificationCodeExpiresAt
    ? new Date(auth.verificationCodeExpiresAt)
    : null

    const submittedHash = hashCustomerManagementValue(code)
    const storedHash = String(auth.verificationCodeHash || '')

    const isValid =
    storedHash &&
    safeTokenEquals(storedHash, submittedHash) &&
    expiresAt &&
    !Number.isNaN(expiresAt.getTime()) &&
    expiresAt > new Date()

    if (!isValid) {
    return Response.json(
    {
    success: false,
    message: 'Invalid or expired verification code.',
    },
    {
    status: 401,
    },
    )
    }

    const managementToken = generateCustomerManagementToken()
    const managementTokenHash = hashCustomerManagementValue(managementToken)

    const updatedReservation = await req.payload.update({
    collection: 'reservations',
    id: reservation.id,
    data: {
    customerManagementAuth: {
    ...auth,
    verificationCodeHash: null,
    verificationCodeExpiresAt: null,
    managementTokenHash,
    managementTokenExpiresAt: getManagementExpiryDate(
    CUSTOMER_MANAGEMENT_TOKEN_TTL_HOURS * 60,
    ),
    lastVerifiedAt: new Date().toISOString(),
    },
    } as any,
    overrideAccess: true,
    })

    return Response.json({
    success: true,
    managementToken,
    booking: getCustomerReservationSummary(updatedReservation),
    })
    } catch (error) {
    console.error('[customer-management/verify-code] failed', error)

    return Response.json(
    {
    success: false,
    message: 'Could not verify booking code.',
    },
    {
    status: 500,
    },
    )
    }
    },
    },
    {
    path: '/customer-management/booking',
    method: 'get',
    handler: async (req) => {
    try {
    const requestUrl = req.url
      ? new URL(req.url)
      : new URL('http://localhost/api/reservations/customer-management/booking')

    const authorizationHeader =
      typeof req.headers?.get === 'function' ? req.headers.get('authorization') || '' : ''

    const token =
      requestUrl.searchParams.get('token') ||
      String(authorizationHeader).replace(/^Bearer\s+/i, '')

    const reservation = await findReservationByManagementToken({
    payload: req.payload,
    token,
    })

    if (!reservation) {
    return Response.json(
    {
    success: false,
    message: 'Invalid or expired booking management token.',
    },
    {
    status: 401,
    },
    )
    }

    return Response.json({
    success: true,
    booking: getCustomerReservationSummary(reservation),
    })
    } catch (error) {
    console.error('[customer-management/booking] failed', error)

    return Response.json(
    {
    success: false,
    message: 'Could not load booking.',
    },
    {
    status: 500,
    },
    )
    }
    },
    },
    {
    path: '/customer-management/cancel',
    method: 'post',
    handler: async (req) => {
    try {
    const body = await getRequestJsonBody(req)
    const token = String(body?.token || '').trim()
    const reason = String(body?.reason || '').trim()

    const reservation = await findReservationByManagementToken({
    payload: req.payload,
    token,
    })

    if (!reservation) {
    return Response.json(
    {
    success: false,
    message: 'Invalid or expired booking management token.',
    },
    {
    status: 401,
    },
    )
    }

    if (reservation.status === 'cancelled') {
    return Response.json(
    {
    success: false,
    message: 'This booking has already been cancelled.',
    },
    {
    status: 400,
    },
    )
    }

    const policy = getReservationPolicyResult(reservation)

    const refundStatus =
    policy.estimatedRefundAmount > 0 ? 'refund_due' : 'not_required'

    const updatedReservation = await req.payload.update({
    collection: 'reservations',
    id: reservation.id,
    data: {
    status: 'cancelled',
    customerCancellation: {
    ...(reservation.customerCancellation || {}),
    requestedAt: new Date().toISOString(),
    cancelledAt: new Date().toISOString(),
    cancelledBy: 'customer',
    reason,
    refundPercentage: policy.refundPercentage,
    refundAmount: policy.estimatedRefundAmount,
    cancellationWindow: policy.cancellationWindow,
    refundStatus,
    },
    } as any,
    overrideAccess: true,
    })

    if (policy.estimatedRefundAmount > 0) {
    await sendAdminRefundPendingEmail({
    reservation,
    refundAmount: policy.estimatedRefundAmount,
    refundPercentage: policy.refundPercentage,
    cancellationWindow: policy.cancellationWindow,
    reason,
    })
    }

    return Response.json({
    success: true,
    message:
    policy.estimatedRefundAmount > 0
    ? 'Your booking has been cancelled. Your refund request is pending admin approval.'
    : 'Your booking has been cancelled. This booking is not eligible for a refund under the cancellation policy.',
    booking: getCustomerReservationSummary(updatedReservation),
    })
    } catch (error) {
    console.error('[customer-management/cancel] failed', error)

    return Response.json(
    {
    success: false,
    message: 'Could not cancel booking.',
    },
    {
    status: 500,
    },
    )
    }
    },
    },
    {
    path: '/:id/approve-customer-refund',
    method: 'patch',
    handler: async (req) => {
    const routeParams = (req as any).routeParams || {}
    const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id

    try {
    if (!req.user) {
    return Response.json(
    {
    success: false,
    message: 'Admin authentication required.',
    },
    {
    status: 401,
    },
    )
    }

    if (!id) {
    return Response.json(
    {
    success: false,
    message: 'Missing reservation ID.',
    },
    {
    status: 400,
    },
    )
    }

    const body = await getRequestJsonBody(req)
    const approvalNotes = String(body?.approvalNotes || body?.notes || '').trim()

    const reservation = await req.payload.findByID({
    collection: 'reservations',
    id,
    depth: 1,
    overrideAccess: true,
    })

    const cancellation = reservation?.customerCancellation || {}
    const refundAmount = Number(cancellation?.refundAmount || 0)

    if (refundAmount <= 0) {
    return Response.json(
    {
    success: false,
    message: 'This reservation has no refund amount to approve.',
    },
    {
    status: 400,
    },
    )
    }

    if (cancellation?.refundStatus === 'approved' || cancellation?.refundStatus === 'refunded') {
    return Response.json(
    {
    success: false,
    message: 'This refund has already been approved or refunded.',
    },
    {
    status: 400,
    },
    )
    }

    const updatedReservation = await req.payload.update({
    collection: 'reservations',
    id,
    data: {
    customerCancellation: {
    ...cancellation,
    refundStatus: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy: req.user.id,
    approvalNotes,
    },
    } as any,
    overrideAccess: true,
    })

    return Response.json({
    success: true,
    message: 'Refund approved. Please process the actual refund payment and mark it as refunded once complete.',
    booking: getCustomerReservationSummary(updatedReservation),
    })
    } catch (error) {
    console.error('[approve-customer-refund] failed', error)

    return Response.json(
    {
    success: false,
    message: 'Could not approve refund.',
    },
    {
    status: 500,
    },
    )
    }
    },
    },
    {
    path: '/:id/mark-customer-refunded',
    method: 'patch',
    handler: async (req) => {
    const routeParams = (req as any).routeParams || {}
    const id = Array.isArray(routeParams.id) ? routeParams.id[0] : routeParams.id

    try {
    if (!req.user) {
    return Response.json(
    {
    success: false,
    message: 'Admin authentication required.',
    },
    {
    status: 401,
    },
    )
    }

    if (!id) {
    return Response.json(
    {
    success: false,
    message: 'Missing reservation ID.',
    },
    {
    status: 400,
    },
    )
    }

    const reservation = await req.payload.findByID({
    collection: 'reservations',
    id,
    depth: 1,
    overrideAccess: true,
    })

    const cancellation = reservation?.customerCancellation || {}

    if (cancellation?.refundStatus !== 'approved') {
    return Response.json(
    {
    success: false,
    message: 'Refund must be approved before it can be marked as refunded.',
    },
    {
    status: 400,
    },
    )
    }

    const updatedReservation = await req.payload.update({
    collection: 'reservations',
    id,
    data: {
    customerCancellation: {
    ...cancellation,
    refundStatus: 'refunded',
    refundedAt: new Date().toISOString(),
    },
    } as any,
    overrideAccess: true,
    })

    return Response.json({
    success: true,
    message: 'Refund marked as paid/refunded.',
    booking: getCustomerReservationSummary(updatedReservation),
    })
    } catch (error) {
    console.error('[mark-customer-refunded] failed', error)

    return Response.json(
    {
    success: false,
    message: 'Could not mark refund as refunded.',
    },
    {
    status: 500,
    },
    )
    }
    },
    },

    {
      path: '/customer-management/available-extras',
      method: 'get',
      handler: async (req) => {
        try {
          const requestUrl = req.url
            ? new URL(req.url)
            : new URL('http://localhost/api/reservations/customer-management/available-extras')

          const authorizationHeader =
            typeof req.headers?.get === 'function' ? req.headers.get('authorization') || '' : ''

          const token =
            requestUrl.searchParams.get('token') ||
            String(authorizationHeader).replace(/^Bearer\s+/i, '')

          const reservation = await findReservationByManagementToken({
            payload: req.payload,
            token,
          })

          if (!reservation) {
            return Response.json(
              {
                success: false,
                message: 'Invalid or expired booking management token.',
              },
              {
                status: 401,
              },
            )
          }

          const policy = getReservationPolicyResult(reservation)

          if (!policy.canCustomerAddExtras) {
            return Response.json({
              success: true,
              canAddExtras: false,
              message: 'Extras cannot be added online because the trip is within 36 hours or has already started. Please contact customer support for last-minute extras requests.',
              extras: [],
              booking: getCustomerReservationSummary(reservation),
            })
          }

          const availableExtras = await getAvailableExtrasForReservation({
            payload: req.payload,
            reservation,
          })

          return Response.json({
            success: true,
            canAddExtras: true,
            extras: getCustomerExtrasSummary(availableExtras),
            booking: getCustomerReservationSummary(reservation),
          })
        } catch (error) {
          console.error('[customer-management/available-extras] failed', error)

          return Response.json(
            {
              success: false,
              message: 'Could not load available extras.',
            },
            {
              status: 500,
            },
          )
        }
      },
    },
    {
      path: '/customer-management/add-extras',
      method: 'post',
      handler: async (req) => {
        try {
          const body = await getRequestJsonBody(req)
          const token = String(body?.token || '').trim()
          const selectedExtras = Array.isArray(body?.extras) ? body.extras : []

          if (!token) {
            return Response.json(
              {
                success: false,
                message: 'Booking management token is required.',
              },
              {
                status: 400,
              },
            )
          }

          if (selectedExtras.length === 0) {
            return Response.json(
              {
                success: false,
                message: 'Please select at least one extra.',
              },
              {
                status: 400,
              },
            )
          }

          const reservation = await findReservationByManagementToken({
            payload: req.payload,
            token,
          })

          if (!reservation) {
            return Response.json(
              {
                success: false,
                message: 'Invalid or expired booking management token.',
              },
              {
                status: 401,
              },
            )
          }

          if (String(reservation.status || '').toLowerCase() === 'cancelled') {
            return Response.json(
              {
                success: false,
                message: 'Extras cannot be added to a cancelled booking.',
              },
              {
                status: 400,
              },
            )
          }

          const policy = getReservationPolicyResult(reservation)

          if (!policy.canCustomerAddExtras) {
            return Response.json(
              {
                success: false,
                message: 'Extras cannot be added online because the trip is within 36 hours or has already started. Please contact customer support for last-minute extras requests.',
              },
              {
                status: 400,
              },
            )
          }

          const availableExtras = await getAvailableExtrasForReservation({
            payload: req.payload,
            reservation,
          })

          const availableExtrasMap = new Map<string, any>()
          availableExtras.forEach((extra) => availableExtrasMap.set(String(extra.id), extra))

          const normalizedSelections = selectedExtras
            .map((item: any) => {
              const extraId = String(item?.extraId || item?.id || item?.extra || '').trim()
              const quantity = normalizeCustomerExtraQuantity(item?.quantity)

              return {
                extraId,
                quantity,
              }
            })
            .filter((item: any) => item.extraId && availableExtrasMap.has(item.extraId))

          if (normalizedSelections.length === 0) {
            return Response.json(
              {
                success: false,
                message: 'None of the selected extras are available for this yacht.',
              },
              {
                status: 400,
              },
            )
          }

          const existingExtras = Array.isArray(reservation.extras) ? reservation.extras : []
          const mergedExtras = [...existingExtras]

          let addedAmount = 0
          const addedItems: Array<{
            extraId: string
            name: string
            quantity: number
            unitPrice: number
            total: number
          }> = []

          normalizedSelections.forEach((selection: { extraId: string; quantity: number }) => {
            const availableExtra = availableExtrasMap.get(selection.extraId)
            const unitPrice = Number(availableExtra?.price || 0)
            const lineTotal = unitPrice * selection.quantity

            if (lineTotal <= 0) return

            addedAmount += lineTotal
            addedItems.push({
              extraId: selection.extraId,
              name: availableExtra.name,
              quantity: selection.quantity,
              unitPrice,
              total: lineTotal,
            })

            const existingIndex = mergedExtras.findIndex((row: any) => {
              return getRelationshipId(row?.extra) === selection.extraId
            })

            if (existingIndex >= 0) {
              const existingRow = mergedExtras[existingIndex]
              mergedExtras[existingIndex] = {
                ...existingRow,
                quantity: Number(existingRow?.quantity || 0) + selection.quantity,
                unitPrice: Number(existingRow?.unitPrice || unitPrice),
              }
            } else {
              mergedExtras.push({
                extra: selection.extraId,
                quantity: selection.quantity,
                unitPrice,
              })
            }
          })

          addedAmount = Math.round(addedAmount)

          if (addedAmount <= 0) {
            return Response.json(
              {
                success: false,
                message: 'Selected extras do not have a valid price.',
              },
              {
                status: 400,
              },
            )
          }

          const existingPayments = Array.isArray(reservation.payments) ? reservation.payments : []
          const existingTotalPrice = Number(reservation.totalPrice || 0)
          const newTotalPrice = existingTotalPrice + addedAmount

          const existingPaidAmount = getCompletedReservationPaidAmount(reservation)
          const newBalanceDue = Math.max(0, Math.round(newTotalPrice - existingPaidAmount))

          const feeFields = getPaymentFeeFields({
            amount: addedAmount,
            method: 'Mamo Pay',
          })

          const extraPaymentRow = {
            id: `extra-${Date.now()}`,
            kind: 'adjustment',
            createdAt: new Date().toISOString(),
            installedAt: new Date().toISOString(),
            amount: addedAmount,
            method: 'Mamo Pay',
            ...feeFields,
            date: new Date().toISOString(),
            status: 'pending',
            balance: newBalanceDue,
            notes: `Customer added extras from manage booking: ${addedItems
              .map((item) => `${item.name} x ${item.quantity}`)
              .join(', ')}`,
          }

          const updatedPayments = [...existingPayments, extraPaymentRow]
          const nextStatus = getReservationStatusFromPayments({
            payments: updatedPayments,
            totalPrice: newTotalPrice,
          })

          let updatedReservation = await req.payload.update({
            collection: 'reservations',
            id: reservation.id,
            data: {
              extras: mergedExtras,
              totalPrice: newTotalPrice,
              status: nextStatus,
              payments: updatedPayments,
              paymentsUpdateSource: 'payment-manager',
            } as any,
            overrideAccess: true,
            context: {
              paymentsUpdateSource: 'payment-manager',
            },
          })

          await activateDueScheduledPayments(req.payload)

          updatedReservation = await req.payload.findByID({
            collection: 'reservations',
            id: reservation.id,
            depth: 2,
            overrideAccess: true,
          })

          return Response.json({
            success: true,
            message:
              'Extras have been added to your booking. A payment link has been requested for immediate payment so our team can book these extras.',
            addedAmount,
            addedItems,
            booking: getCustomerReservationSummary(updatedReservation),
          })
        } catch (error) {
          console.error('[customer-management/add-extras] failed', error)

          return Response.json(
            {
              success: false,
              message: 'Could not add extras to booking.',
            },
            {
              status: 500,
            },
          )
        }
      },
    },

  ],

  admin: {
    defaultColumns: ['transactionId', 'boat', 'supplier', 'user', 'status', 'startTime', 'endTime'],
  },
  access: {
    read: ({ req }) => {
      if (req.query?.where) return true
      return req.user ? true : false
    },
    create: () => true,
    update: ({ req }) => !!req.user,
    delete: ({ req }) => !!req.user,
  },

  hooks: {
    beforeChange: [
      async ({ data, originalDoc, operation, req, context }) => {
        // Payment ledger safety guard:
        // Only the Payment Schedule Manager direct save is allowed to update payments.
        // Normal Payload page saves can submit stale payments form state, so they must preserve
        // the existing payment ledger.
        if (operation !== 'update') return data

        return await preserveExistingPaymentsForNormalReservationSave(data, originalDoc, req, context)
      },

      async ({ data, operation, originalDoc }) => {
        // Only applies on update where status is changing
        const prevStatus = (originalDoc as any)?.status
        const nextStatus = (data as any)?.status

        const isPendingToAwaiting =
          operation === 'update' && prevStatus === 'pending' && nextStatus === 'awaiting payment'

        if (!isPendingToAwaiting) return data

        const meetingPointName = String(
          (data as any)?.meetingPointName || (originalDoc as any)?.meetingPointName || '',
        ).trim()
        const meetingPointPin = String(
          (data as any)?.meetingPointPin || (originalDoc as any)?.meetingPointPin || '',
        ).trim()
        const contactPersonName = String(
          (data as any)?.contactPersonName || (originalDoc as any)?.contactPersonName || '',
        ).trim()
        const contactPersonNumber = String(
          (data as any)?.contactPersonNumber || (originalDoc as any)?.contactPersonNumber || '',
        ).trim()
        const parkingLocationName = String(
          (data as any)?.parkingLocationName || (originalDoc as any)?.parkingLocationName || '',
        ).trim()
        const parkingLocationPin = String(
          (data as any)?.parkingLocationPin || (originalDoc as any)?.parkingLocationPin || '',
        ).trim()

        const payments = Array.isArray((data as any)?.payments)
          ? (data as any).payments
          : Array.isArray((originalDoc as any)?.payments)
            ? (originalDoc as any).payments
            : []

        const totalPrice = Number((data as any)?.totalPrice ?? (originalDoc as any)?.totalPrice ?? 0)

        const activePayments = payments.filter((payment: any) =>
          ['scheduled', 'pending', 'completed'].includes(payment?.status),
        )

        const activePaymentTotal = activePayments.reduce((sum: number, payment: any) => {
          return sum + Number(payment?.amount || 0)
        }, 0)

        const missing: string[] = []

        if (!meetingPointName) missing.push('Meeting Point - Name')
        if (!meetingPointPin) missing.push('Meeting Point - Google Maps Pin')
        if (!contactPersonName) missing.push('Contact Person - Name')
        if (!contactPersonNumber) missing.push('Contact Person - Number')
        if (!parkingLocationName) missing.push('Car Parking Location - Name')
        if (!parkingLocationPin) missing.push('Car Parking Location - Google Maps Pin')

        if (activePayments.length === 0) {
          missing.push(
            'Payment Schedule Manager - add at least one scheduled, awaiting, or received payment row',
          )
        }

        if (
          totalPrice > 0 &&
          activePayments.length > 0 &&
          Math.round(activePaymentTotal) < Math.round(totalPrice)
        ) {
          missing.push(
            `Payment Schedule Manager - active payment rows must cover the reservation total of AED ${Math.round(
              totalPrice,
            ).toLocaleString()}. Current active payment total is AED ${Math.round(
              activePaymentTotal,
            ).toLocaleString()}`,
          )
        }

        // Admin-facing validation is handled by the Status field validate function.
        // Keep this hook non-throwing so Payload Admin does not mask the message as
        // a generic "Something went wrong" error.

        return data
      },

      async ({ data, req, operation, originalDoc }) => {
        try {
          // Set transaction ID to the document ID for new reservations
          if (operation === 'create' && !data.transactionId) {
            // We'll set this in afterChange since we don't have the ID yet
            data.transactionId = 'pending-' + Date.now()
          }

          // Respect an explicitly provided user; otherwise, set a default

          if (data.boat || data.startTime || data.endTime) {
            let shouldAutoCalculateTotalPrice = true

            try {
              let boatPrice = 0
              let boatPriceDay = 0

              // Get boat prices if boat is selected
              if (data.boat) {
                const boatId = typeof data.boat === 'object' ? data.boat.id : data.boat
                const boat = await req.payload.findByID({
                  req,
                  collection: 'boats',
                  id: boatId,
                  depth: 2,
                  overrideAccess: true,
                })
                boatPrice = boat.price
                boatPriceDay = boat.priceDay
                data.boatHourlyPrice = boatPrice
                data.boatDailyPrice = boatPriceDay

                const boatOwner = (boat as any)?.owner
                const supplierId =
                  typeof boatOwner === 'object'
                    ? boatOwner?.id
                    : typeof boatOwner === 'string'
                      ? boatOwner
                      : null

                if (supplierId) {
                  ;(data as any).supplier = supplierId
                }

                try {
                  const boatLoc: any = (boat as any)?.location
                  const locationId =
                    typeof boatLoc === 'object'
                      ? boatLoc?.id
                      : typeof boatLoc === 'string'
                        ? boatLoc
                        : null

                  if (locationId) {
                    const locationDoc: any = await req.payload.findByID({
                      collection: 'locations',
                      id: locationId,
                      depth: 0,
                      overrideAccess: true,
                    })

                    const label =
                      (typeof locationDoc?.name === 'string' && locationDoc.name.trim()) ||
                      (typeof locationDoc?.harbour === 'string' && locationDoc.harbour.trim()) ||
                      [locationDoc?.city, locationDoc?.country].filter(Boolean).join(', ')

                    if (label) (data as any).departureLocation = label
                  }
                } catch (e) {
                  const logger = (req as any)?.payload?.logger
                  if (logger?.warn) {
                    logger.warn(
                      { err: e },
                      'Departure location auto-copy failed (reservation.departureLocation)',
                    )
                  } else {
                    console.warn(
                      'Departure location auto-copy failed (reservation.departureLocation):',
                      e,
                    )
                  }
                }
              } else if (originalDoc) {
                // Use existing prices from original document if boat hasn't changed
                boatPrice = originalDoc.boatHourlyPrice || 0
                boatPriceDay = originalDoc.boatDailyPrice || 0
                data.boatHourlyPrice = boatPrice
                data.boatDailyPrice = boatPriceDay

                if (!(data as any).departureLocation && (originalDoc as any)?.departureLocation) {
                  ;(data as any).departureLocation = (originalDoc as any).departureLocation
                }
              }

              const hasExplicitTotalPrice =
                typeof data.totalPrice === 'number' && Number.isFinite(data.totalPrice)

              const isFrontendCreate = operation === 'create' && !req.user

              const boatChanged =
                !!originalDoc &&
                data.boat &&
                String(typeof data.boat === 'object' ? data.boat.id : data.boat) !==
                  String(
                    typeof originalDoc.boat === 'object' ? originalDoc.boat?.id : originalDoc.boat,
                  )

              const startChanged =
                !!originalDoc && !!data.startTime && data.startTime !== originalDoc.startTime
              const endChanged =
                !!originalDoc && !!data.endTime && data.endTime !== originalDoc.endTime

              const totalUnchanged =
                !!originalDoc &&
                hasExplicitTotalPrice &&
                Number(data.totalPrice) === Number(originalDoc.totalPrice ?? 0)

              shouldAutoCalculateTotalPrice =
                !hasExplicitTotalPrice ||
                (!isFrontendCreate &&
                  operation === 'update' &&
                  (boatChanged || startChanged || endChanged) &&
                  totalUnchanged)

              if (shouldAutoCalculateTotalPrice) {
                // Calculate total if we have both start and end times
                if (data.startTime && data.endTime) {
                  const startTime = new Date(data.startTime)
                  const endTime = new Date(data.endTime)

                  if (endTime > startTime) {
                    const diffInMs = endTime.getTime() - startTime.getTime()
                    const hours = Math.ceil(diffInMs / (1000 * 60 * 60))

                    // Use daily price if duration is 24 hours or more, otherwise hourly
                    if (hours >= 24) {
                      const days = Math.ceil(hours / 24)
                      data.totalPrice = days * boatPriceDay
                    } else {
                      data.totalPrice = hours * boatPrice
                    }

                    console.log('Price calculation:', {
                      hours,
                      boatPrice,
                      boatPriceDay,
                      totalPrice: data.totalPrice,
                    })
                  } else {
                    data.totalPrice = 0
                    console.log('Invalid time range: endTime must be after startTime')
                  }
                } else {
                  data.totalPrice = 0
                  console.log('Missing startTime or endTime')
                }
              }
            } catch (error) {
              console.error('Error calculating prices:', error)
              if (shouldAutoCalculateTotalPrice) {
                data.totalPrice = 0
              }
            }
          }

          return data
        } catch (error) {
          console.error('Error setting default reservation user:', error)
          return data
        }
      },
      async ({ data, originalDoc, req, operation, context }) => {
        try {
          const calculatedData = await calculateReservationTotalForSave({
            req,
            data: await preserveExistingPaymentsForNormalReservationSave(data, originalDoc, req, context),
            originalDoc,
          })

          const normalisedData = normaliseManualPaymentRowsForSave(calculatedData, originalDoc)

          validateReservationPaymentSchedule({
            data: normalisedData,
            originalDoc,
            operation,
            context,
          })

          return normalisedData
        } catch (error) {
          console.error('Error calculating final reservation total:', error)

          const preservedData = await preserveExistingPaymentsForNormalReservationSave(
            data,
            originalDoc,
            req,
            context,
          )

          const normalisedData = normaliseManualPaymentRowsForSave(preservedData, originalDoc)

          validateReservationPaymentSchedule({
            data: normalisedData,
            originalDoc,
            operation,
            context,
          })

          return normalisedData
        }
      },
      async ({ data }) => {
        // Remove internal payment-manager marker before final persistence.
        // It is not a real collection field and is only needed during beforeChange hooks.
        if ((data as any)?.paymentsUpdateSource) {
          const { paymentsUpdateSource, ...cleanData } = data as any
          return cleanData
        }

        return data
      },
    ],
    afterChange: [
      async ({ doc: untypedDoc, previousDoc: untypedPreviousDoc, operation, req }) => {
        const doc = untypedDoc as Reservation
        const previousDoc = untypedPreviousDoc as Reservation | undefined

        try {
          const currentBoatId = getRelationshipId(doc.boat)
          const previousBoatId = getRelationshipId(previousDoc?.boat)

          const boatIds = Array.from(
            new Set([currentBoatId, previousBoatId].filter(Boolean) as string[]),
          )

          await Promise.all(
            boatIds.map((boatId) =>
              updateBoatReservationCount({
                payload: req.payload,
                boatId,
                req,
              }),
            ),
          )
        } catch (e) {
          console.error('Reservation count update failed:', e)
        }

        // ✅ COUPON USAGE COUNT (put this BEFORE any early returns)
        try {
          const couponId = typeof doc.coupon === 'object' ? doc.coupon?.id : doc.coupon

          const prevCouponId =
            typeof previousDoc?.coupon === 'object' ? previousDoc?.coupon?.id : previousDoc?.coupon

          // Count on create, or when coupon changes
          const shouldIncrement =
            !!couponId && (operation === 'create' || couponId !== prevCouponId)

          if (shouldIncrement) {
            const couponDoc = await req.payload.findByID({
              req,
              collection: 'coupons',
              id: couponId,
              depth: 0,
              overrideAccess: true,
            })

            await req.payload.update({
              req,
              collection: 'coupons',
              id: couponId,
              data: { usageCount: Number(couponDoc.usageCount || 0) + 1 },
              overrideAccess: true,
            })
          }
        } catch (e) {
          console.error('Coupon usageCount update failed:', e)
          // don't throw — keep reservation flow stable
        }

        if (req?.context?.skipPaymentReconciliation !== true) {
          try {
            await reconcileReservationPaymentsAfterTotalChange({
              doc,
              previousDoc,
              req,
            })
          } catch (paymentReconciliationError) {
            console.error('Payment reconciliation after total change failed:', paymentReconciliationError)
          }
        }

        const shouldSuppressReservationEmails =
          req?.context?.skipReservationStatusEmails === true ||
          req?.context?.skipCustomerEmails === true ||
          req?.context?.skipAdminEmails === true ||
          req?.context?.manualPaymentReconciliation === true

        if (shouldSuppressReservationEmails) {
          return doc
        }

        // Check if we need to process status changes
        const shouldProcessStatusChange =
          operation === 'create' || (operation === 'update' && doc.status !== previousDoc?.status)

        const forceReservationDeskAwaitingPaymentEmail =
          req?.context?.reservationDeskForceAwaitingPaymentEmail === true &&
          doc.status === 'awaiting payment'

        // Check if we need to process payment link creation
        const shouldProcessPaymentLink =
          doc.status === 'awaiting payment' &&
          ((!previousDoc || previousDoc.status !== 'awaiting payment') ||
            forceReservationDeskAwaitingPaymentEmail)

        // Don't process if this is a payment confirmation (handled by polling)
        const isPaymentConfirmation =
          !req.user &&
          previousDoc?.status === 'awaiting payment' &&
          ['confirmed', 'confirmed_balance_due'].includes(doc.status)

        // ✅ FIX: prevent double confirmed emails (polling sends, afterChange skips)
        if ((!shouldProcessStatusChange && !shouldProcessPaymentLink) || isPaymentConfirmation)
          return doc

        try {
          console.log(`Processing ${operation} with status: ${doc.status}`)

          const { payload } = req
          //const userId = typeof doc.user === 'object' ? doc.user.id : doc.user
          const boatId = typeof doc.boat === 'object' ? doc.boat.id : doc.boat

          const boat = (await payload.findByID({
            collection: 'boats',
            id: boatId,
            depth: 2,
            overrideAccess: true,
          })) as unknown as Boat

          const user = {
            name: doc.guestName || (typeof doc.user === 'string' ? doc.user : '') || 'Guest',
            email: doc.guestEmail || '',
          } as unknown as User

          if (!boat) {
            console.error('Missing boat data')
            return
          }

          // Activate the Payment Schedule Manager rows when status changes to awaiting payment.
          // The payment schedule is now the source of truth. Legacy top-level paymentLink/paymentLinkId
          // are only mirrored from the first active Mamo Pay row for backwards compatibility.
          if (shouldProcessPaymentLink) {
            const activatedSchedule = await activatePaymentScheduleForReservation({
              reservation: doc,
              boat,
              user,
              payload,
            })

            if (!activatedSchedule.paymentLink) {
              throw new Error('Mamo Pay link was not created for this awaiting-payment reservation.')
            }

            startPaymentPolling(payload)

              if (!user.email) {
                throw new Error(`Guest email is missing for booking #${doc.transactionId || doc.id}`)
              }

              await sendEmail(
                user.email,
                `Book That Boat - Yacht Rental Dubai - Booking #${doc.transactionId || doc.id}`,
                getStatusEmailContent('user', 'awaiting payment', boat, user, {
                  ...doc,
                  payments: activatedSchedule.payments,
                  paymentLink: activatedSchedule.paymentLink,
                  paymentLinkId: activatedSchedule.paymentLinkId,
                }),
              )

              await sendEmail(
                EMAIL_CONFIG.adminEmail,
                '[Admin] Payment Required for Booking',
                getStatusEmailContent('admin', 'awaiting payment', boat, user, {
                  ...doc,
                  payments: activatedSchedule.payments,
                  paymentLink: activatedSchedule.paymentLink,
                  paymentLinkId: activatedSchedule.paymentLinkId,
                }),
              )

              doc.payments = activatedSchedule.payments
              doc.paymentLink = activatedSchedule.paymentLink
              doc.paymentLinkId = activatedSchedule.paymentLinkId

            return doc
          }

          // Send emails only for status changes that are NOT payment-related
          if (shouldProcessStatusChange && doc.status !== 'awaiting payment') {
            try {
              if (user.email) {
                await sendEmail(
                  user.email,
                  doc.status === 'pending'
                    ? `Reservation Request #${doc.transactionId || doc.id} has been received`
                    : `Book That Boat - Yacht Rental Dubai - Booking #${doc.transactionId || doc.id}`,
                  getStatusEmailContent('user', doc.status, boat, user, doc),
                )
              }

              await sendEmail(
                EMAIL_CONFIG.adminEmail,
                `[Admin] Booking ${doc.status}: ${boat.name}`,
                getStatusEmailContent('admin', doc.status, boat, user, doc),
              )
            } catch (emailError: any) {
              console.error('Email sending failed:', emailError.message)
            }
          }
        } catch (error: unknown) {
          console.error('Error in afterChange hook:', error)

          if (
            doc.status === 'awaiting payment' &&
            req?.context?.reservationDeskForceAwaitingPaymentEmail === true
          ) {
            throw error
          }
        }
      },
    ],
    afterDelete: [
      async ({ doc, req }) => {
        try {
          await updateBoatReservationCount({
            payload: req.payload,
            boatId: getRelationshipId((doc as Reservation).boat),
            req,
          })
        } catch (e) {
          console.error('Reservation count update after delete failed:', e)
        }

        return doc
      },
    ],
  },
  fields: [
    {
      name: 'boat',
      type: 'relationship',
      relationTo: 'boats',
      required: false,
      index: true,
      hooks: {
        beforeValidate: [({ value }) => (value === '' ? null : value)],
      },
    },
    {
      name: 'supplier',
      label: 'Supplier',
      type: 'relationship',
      relationTo: 'owners',
      required: false,
      index: true,
      admin: {
        readOnly: true,
        description: 'Auto-copied from the selected boat supplier for admin list visibility.',
      },
      hooks: {
        beforeValidate: [({ value }) => (value === '' ? null : value)],
      },
    },
    {
      name: 'departureLocation',
      type: 'text',
      label: 'Departure Location',
      required: false,
      admin: {
        readOnly: true,
        description: 'Auto-copied from the selected boat location (used in client emails).',
      },
    },
    {
      name: 'meetingPointName',
      type: 'text',
      label: 'Meeting Point - Name',
      required: false,
      admin: {
        position: 'sidebar',
        description: 'e.g. Dubai Marina',
      },
    },
    {
      name: 'meetingPointPin',
      type: 'text',
      label: 'Meeting Point - Google Maps Pin',
      required: false,
      admin: {
        position: 'sidebar',
        description: 'e.g. https://share.google/xxxx',
      },
    },
    {
      name: 'contactPersonName',
      type: 'text',
      label: 'Contact Person - Name',
      required: false,
      admin: {
        position: 'sidebar',
        description: 'e.g. John',
      },
    },
    {
      name: 'contactPersonNumber',
      type: 'text',
      label: 'Contact Person - Number',
      required: false,
      admin: {
        position: 'sidebar',
        description: 'e.g. +97143408933',
      },
    },
    {
      name: 'parkingLocationName',
      type: 'text',
      label: 'Car Parking Location - Name',
      required: false,
      admin: {
        position: 'sidebar',
        description: 'e.g. Dubai Marina',
      },
    },
    {
      name: 'parkingLocationPin',
      type: 'text',
      label: 'Car Parking Location - Google Maps Pin',
      required: false,
      admin: {
        position: 'sidebar',
        description: 'e.g. https://share.google/xxxx',
      },
    },
    {
      name: 'paymentMethod',
      type: 'select',
      label: 'Payment Plan',
      options: [
        { label: 'Pay in Full', value: 'full' },
        { label: 'Scheduled Payments / Instalments', value: 'scheduled' },

        // Legacy values kept so old reservations continue to render correctly.
        { label: 'Legacy: Deposit + Balance', value: 'deposit_balance' },
        { label: 'Legacy: Custom Installments', value: 'installments' },
      ],
      defaultValue: 'full',
      required: true,
      admin: {
        hidden: true,
        position: 'sidebar',
        description:
          'Legacy field kept for backwards compatibility. Payment Schedule Manager now defines whether a booking is full payment or scheduled payments.',
      },
    },
    {
      name: 'numberOfInstallments',
      type: 'number',
      label: 'Number of Installments',
      required: false,
      defaultValue: 3,
      admin: {
        hidden: true,
        position: 'sidebar',
        condition: (data) => data?.paymentMethod === 'installments',
        description: 'Legacy field. Payment schedule is now managed through Payment Manager.',
      },
    },
    {
      name: 'downPaymentAmount',
      type: 'number',
      label: 'Down Payment Amount (AED)',
      required: false,
      admin: {
        hidden: true,
        position: 'sidebar',
        condition: (data) => data?.paymentMethod === 'installments' || data?.paymentMethod === 'deposit_balance',
        description:
          'Legacy field. Payment schedule is now managed through Payment Manager.',
      },
    },

    {
      name: 'guests',
      type: 'number',
      required: false,
      label: 'Number of Guests',
    },
    {
      name: 'user',
      type: 'text',
      required: false,
      label: 'Guest Name',
    },
    {
      name: 'guestEmail',
      type: 'text',
      required: false,
    },
    {
      name: 'countryCode',
      type: 'select',
      label: 'Country Code',
      required: true,
      admin: {
        width: '50%',
      },
      options: getCountries()
        .map((countryCode) => {
          const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode)
          return {
            label: `${name} (+${getCountryCallingCode(countryCode)})`,
            value: `+${getCountryCallingCode(countryCode)}`,
          }
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    },
    {
      name: 'guestPhone',
      type: 'text',
      label: 'Guest Phone',
      required: true,
      admin: {
        placeholder: '412 345 678',
        width: '50%',
      },
    },
    {
      name: 'startTime',
      type: 'date',
      required: true,
      admin: {
        date: { pickerAppearance: 'dayAndTime', timeIntervals: 30 },
      },
    },
    {
      name: 'endTime',
      type: 'date',
      required: true,
      admin: {
        date: { pickerAppearance: 'dayAndTime', timeIntervals: 30 },
      },
      validate: (val: Date | null | undefined, { data }: { data?: { startTime?: Date } }) => {
        if (!val || !data?.startTime) return true
        return val > data.startTime ? true : 'End time must be after start time'
      },
    },
    {
      name: 'status',
      type: 'select',
      options: RESERVATION_STATUS_OPTIONS,
      defaultValue: 'pending',
      validate: (value: unknown, validationOptions: any) => {
        const data = validationOptions?.data || {}
        const siblingData = validationOptions?.siblingData || {}
        const originalDoc = validationOptions?.originalDoc || {}

        const message = getAwaitingPaymentValidationMessage({
          data: {
            ...data,
            ...siblingData,
            status: value,
          },
          originalDoc,
        })

        return message || true
      },
    },
    {
      name: 'customerManagementPolicy',
      type: 'group',
      label: 'Customer Management Policy',
      admin: {
        description:
          'Read-only policy summary for customer booking management, cancellation refunds, and extras cutoff.',
        condition: (data) => !!data?.startTime,
      },
      fields: [
        {
          name: 'hoursUntilTrip',
          type: 'number',
          label: 'Hours Until Trip',
          admin: {
            readOnly: true,
            description: 'Calculated from the reservation start time.',
          },
          hooks: {
            afterRead: [
              ({ data }) => {
                const result = getReservationPolicyResult(data)
                return result.hoursUntilTrip
              },
            ],
          },
        },
        {
          name: 'cancellationWindow',
          type: 'select',
          label: 'Cancellation Window',
          options: [
            { label: 'More than 72 hours', value: 'more_than_72_hours' },
            { label: 'Between 24 and 72 hours', value: 'between_24_and_72_hours' },
            { label: 'Less than 24 hours', value: 'less_than_24_hours' },
            { label: 'Trip already started', value: 'trip_started' },
            { label: 'Unknown', value: 'unknown' },
          ],
          admin: {
            readOnly: true,
          },
          hooks: {
            afterRead: [
              ({ data }) => {
                const result = getReservationPolicyResult(data)
                return result.cancellationWindow
              },
            ],
          },
        },
        {
          name: 'refundPercentage',
          type: 'number',
          label: 'Refund Percentage',
          admin: {
            readOnly: true,
            description:
              '100% when more than 72 hours away, 50% between 24 and 72 hours, 0% within 24 hours.',
          },
          hooks: {
            afterRead: [
              ({ data }) => {
                const result = getReservationPolicyResult(data)
                return result.refundPercentage
              },
            ],
          },
        },
        {
          name: 'estimatedRefundAmount',
          type: 'number',
          label: 'Estimated Refund Amount (AED)',
          admin: {
            readOnly: true,
            description:
              'Calculated against completed paid amount where available, otherwise reservation total.',
          },
          hooks: {
            afterRead: [
              ({ data }) => {
                const result = getReservationPolicyResult(data)
                return result.estimatedRefundAmount
              },
            ],
          },
        },
        {
          name: 'canCustomerAddExtras',
          type: 'checkbox',
          label: 'Customer Can Add Extras',
          admin: {
            readOnly: true,
            description: 'Customers can add extras from the manage-booking page only when the trip is more than 36 hours away. Admins can still manage extras manually at any time.',
          },
          hooks: {
            afterRead: [
              ({ data }) => {
                const result = getReservationPolicyResult(data)
                return result.canCustomerAddExtras
              },
            ],
          },
        },
      ],
    },
    {
      name: 'customerCancellation',
      type: 'group',
      label: 'Customer Cancellation',
      admin: {
        description:
          'Audit trail for customer cancellation requests and refund entitlement. Refunds should be reviewed by admin before payment is returned.',
      },
      fields: [
        {
          name: 'requestedAt',
          type: 'date',
          label: 'Cancellation Requested At',
          admin: {
            readOnly: true,
            date: { pickerAppearance: 'dayAndTime' },
          },
        },
        {
          name: 'cancelledAt',
          type: 'date',
          label: 'Cancelled At',
          admin: {
            readOnly: true,
            date: { pickerAppearance: 'dayAndTime' },
          },
        },
        {
          name: 'cancelledBy',
          type: 'select',
          label: 'Cancelled By',
          options: [
            { label: 'Customer', value: 'customer' },
            { label: 'Admin', value: 'admin' },
            { label: 'System', value: 'system' },
          ],
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'reason',
          type: 'textarea',
          label: 'Cancellation Reason',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'refundPercentage',
          type: 'number',
          label: 'Refund Percentage',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'refundAmount',
          type: 'number',
          label: 'Refund Amount (AED)',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'cancellationWindow',
          type: 'select',
          label: 'Cancellation Window',
          options: [
            { label: 'More than 72 hours', value: 'more_than_72_hours' },
            { label: 'Between 24 and 72 hours', value: 'between_24_and_72_hours' },
            { label: 'Less than 24 hours', value: 'less_than_24_hours' },
            { label: 'Trip already started', value: 'trip_started' },
            { label: 'Unknown', value: 'unknown' },
          ],
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'refundStatus',
          type: 'select',
          label: 'Refund Status',
          defaultValue: 'not_required',
          options: [
            { label: 'Not Required', value: 'not_required' },
            { label: 'Refund Due / Pending Approval', value: 'refund_due' },
            { label: 'Approved', value: 'approved' },
            { label: 'Refunded', value: 'refunded' },
            { label: 'Rejected', value: 'rejected' },
          ],
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'approvedAt',
          type: 'date',
          label: 'Refund Approved At',
          admin: {
            readOnly: true,
            date: { pickerAppearance: 'dayAndTime' },
          },
        },
        {
          name: 'approvedBy',
          type: 'relationship',
          relationTo: 'users',
          label: 'Refund Approved By',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'approvalNotes',
          type: 'textarea',
          label: 'Refund Approval Notes',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'refundedAt',
          type: 'date',
          label: 'Refund Paid At',
          admin: {
            readOnly: true,
            date: { pickerAppearance: 'dayAndTime' },
          },
        },
      ],
    },
    {
      name: 'customerManagementAuth',
      type: 'group',
      label: 'Customer Management Auth',
      admin: {
        position: 'sidebar',
        description:
          'Hidden authentication metadata for future customer manage-booking OTP or magic-link access.',
      },
      fields: [
        {
          name: 'verificationCodeHash',
          type: 'text',
          admin: {
            hidden: true,
            readOnly: true,
          },
        },
        {
          name: 'verificationCodeExpiresAt',
          type: 'date',
          admin: {
            hidden: true,
            readOnly: true,
          },
        },
        {
          name: 'managementTokenHash',
          type: 'text',
          admin: {
            hidden: true,
            readOnly: true,
          },
        },
        {
          name: 'managementTokenExpiresAt',
          type: 'date',
          admin: {
            hidden: true,
            readOnly: true,
          },
        },
        {
          name: 'lastVerifiedAt',
          type: 'date',
          admin: {
            hidden: true,
            readOnly: true,
          },
        },
      ],
    },
    {
      name: 'paymentLinkId',
      type: 'text',
      label: 'Payment Link ID',
      admin: {
        hidden: true,
        readOnly: true,
      },
    },
    {
      name: 'paymentLink',
      type: 'text',
      label: 'Payment Link',
      admin: {
        hidden: true,
        readOnly: true,
      },
    },
    {
      name: 'customDiscountAmount',
      type: 'number',
      label: 'Custom Discount Amount (AED)',
      required: false,
      min: 0,
      defaultValue: 0,
      admin: {
        description: 'Optional manual discount amount, e.g. enter 100 to take AED 100 off the reservation total.',
        condition: (data) => !!data?.boat && !!data?.startTime && !!data?.endTime,
      },
    },
    {
      name: 'reservationPriceCalculator',
      type: 'ui',
      label: 'Live Reservation Price',
      admin: {
        condition: (data) => !!data?.boat && !!data?.startTime && !!data?.endTime,
        components: {
          Field:
            '/components/ReservationPriceCalculator/ReservationPriceCalculator#ReservationPriceCalculator',
        },
      },
    },
    {
      name: 'totalPrice',
      type: 'number',
      label: 'Total (AED)',
      admin: {
        readOnly: true,
        description: 'Calculated based on duration and boat pricing',
        condition: (data) => !!data?.boat && !!data?.startTime && !!data?.endTime,
      },
    },
    {
      name: 'method',
      type: 'select',
      label: 'Default Payment Method',
      options: ['Mamo Pay', 'Bank Transfer', 'Cash'],
      defaultValue: 'Mamo Pay',
      required: true,
      admin: {
        hidden: true,
        description:
          'Legacy/default method. The Payment Manager row method is the source of truth for each payment.',
      },
    },
    {
      name: 'payments',
      type: 'array',
      label: 'Payment Schedule Manager',
      admin: {
        description:
          'Build and track the reservation payment schedule. Payment links are stored per row.',
        initCollapsed: false,
        components: {
          Field:
            '/components/ReservationPaymentsManager/ReservationPaymentsManager#ReservationPaymentsManager',
        },
      },
      fields: [
        {
          name: 'id',
          type: 'text',
          label: 'Payment ID',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'kind',
          type: 'select',
          label: 'Payment Kind',
          options: [
            { label: 'Full', value: 'full' },
            { label: 'Down Payment', value: 'downpayment' },
            { label: 'Installment', value: 'installment' },
            { label: 'Balance Payment', value: 'balance' },
            { label: 'Adjustment / Refund Review', value: 'adjustment' },
          ],
          admin: { readOnly: true },
        },
        {
          name: 'installmentStage',
          type: 'select',
          label: 'Installment Stage',
          options: [
            { label: 'Paid', value: 'paid' },
            { label: 'Ready to be installed', value: 'ready_to_be_installed' },
            { label: 'Installed & ready to be paid', value: 'installed_ready_to_be_paid' },
          ],
          admin: { readOnly: true },
        },
        {
          name: 'createdAt',
          type: 'date',
          label: 'Created At',
          admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } },
        },
        {
          name: 'installedAt',
          type: 'date',
          label: 'Installed At',
          admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } },
        },
        {
          name: 'paidAt',
          type: 'date',
          label: 'Paid At',
          admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } },
        },
        {
          name: 'amount',
          type: 'number',
          required: true,
          label: 'Amount',
        },
        {
          name: 'method',
          type: 'select',
          label: 'Payment Method',
          options: ['Mamo Pay', 'Bank Transfer', 'Cash'],
          required: true,
        },
        {
          name: 'processingFeePercentage',
          type: 'number',
          label: 'Processing Fee (%)',
          admin: {
            readOnly: true,
            description: 'Mamo Pay processing fee percentage. Zero for bank transfer and cash.',
          },
        },
        {
          name: 'processingFeeAmount',
          type: 'number',
          label: 'Processing Fee Amount (AED)',
          admin: {
            readOnly: true,
            description: 'Fee amount added to Mamo Pay links.',
          },
        },
        {
          name: 'customerPayableAmount',
          type: 'number',
          label: 'Customer Payable Amount (AED)',
          admin: {
            readOnly: true,
            description: 'Payment amount plus processing fee where applicable.',
          },
        },
        {
          name: 'date',
          type: 'date',
          label: 'Due Date',
          required: true,
          admin: {
            date: {
              pickerAppearance: 'dayAndTime',
            },
          },
        },
        {
          name: 'status',
          type: 'select',
          label: 'Payment Status',
          options: [
            { label: 'Scheduled', value: 'scheduled' },
            { label: 'Awaiting Payment', value: 'pending' },
            { label: 'Received', value: 'completed' },
            { label: 'Refunded', value: 'refunded' },
            { label: 'Failed', value: 'failed' },
            { label: 'Cancelled', value: 'cancelled' },
            { label: 'Superseded', value: 'superseded' },
          ],
          defaultValue: 'pending',
          required: true,
        },
        {
          name: 'balance',
          type: 'number',
          label: 'Remaining Balance',
          defaultValue: 0,
          min: 0,
          admin: {
            description: 'Balance remaining after this payment. This is recalculated by the backend when the reservation is saved.',
            readOnly: true,
          },
        },
        {
          name: 'paymentLink',
          type: 'text',
          label: 'Payment Link',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'paymentLinkId',
          type: 'text',
          label: 'Payment Link ID',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'actualPaymentLink',
          type: 'text',
          label: 'Actual Payment Link Used',
          admin: {
            readOnly: true,
            description: 'The payment link actually used by the customer, if different from the generated row link.',
          },
        },
        {
          name: 'actualPaymentLinkId',
          type: 'text',
          label: 'Actual Payment Link ID Used',
          admin: {
            readOnly: true,
            description: 'The Mamo link ID/reference actually used by the customer.',
          },
        },
        {
          name: 'actualMamoChargeId',
          type: 'text',
          label: 'Actual Mamo Charge / Payment Reference',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'actualMamoChargeStatus',
          type: 'text',
          label: 'Actual Mamo Charge Status',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'actualCapturedAmount',
          type: 'number',
          label: 'Actual Captured Amount',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'actualCapturedFeeAmount',
          type: 'number',
          label: 'Actual Mamo Fee Amount',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'actualCapturedNetAmount',
          type: 'number',
          label: 'Actual Net Amount After Fee',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'actualCapturedCurrency',
          type: 'text',
          label: 'Actual Captured Currency',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'actualCapturedAt',
          type: 'date',
          label: 'Actual Captured At',
          admin: {
            readOnly: true,
            date: { pickerAppearance: 'dayAndTime' },
          },
        },
        {
          name: 'reconciledAt',
          type: 'date',
          label: 'Reconciled At',
          admin: {
            readOnly: true,
            date: { pickerAppearance: 'dayAndTime' },
          },
        },
        {
          name: 'reconciledBy',
          type: 'text',
          label: 'Reconciled By',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'reconciliationSource',
          type: 'select',
          label: 'Reconciliation Source',
          options: [
            { label: 'Manual Admin', value: 'manual_admin' },
            { label: 'Mamo Polling', value: 'mamo_polling' },
            { label: 'Webhook', value: 'webhook' },
          ],
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'reconciliationNotes',
          type: 'textarea',
          label: 'Reconciliation Notes',
          admin: {
            readOnly: true,
          },
        },
        {
          name: 'notes',
          type: 'textarea',
          label: 'Notes',
          admin: {
            description: 'Any additional notes about this payment',
          },
        },
      ],
    },
    {
      name: 'transactionId',
      type: 'text',
      label: 'Booking ID',
      unique: true,
      admin: {
        readOnly: true,
        description: 'Booking ID from reservations processor',
      },
      hooks: {
        beforeValidate: [
          ({ value, operation }) => {
            if (operation === 'create' && !value) {
              return Date.now()
            }
            return value
          },
        ],
      },
    },
    {
      name: 'specialRequests',
      type: 'textarea',
      label: 'Special Requests',
    },
    {
      name: 'extras',
      type: 'array',
      fields: [
        {
          name: 'extra',
          type: 'relationship',
          relationTo: 'extras',
          required: true,
          validate: (val: any) => {
            if (!val) return 'Extra is required'
            return true
          },
        },
        {
          name: 'quantity',
          type: 'number',
          required: true,
          min: 1,
        },
        {
          name: 'unitPrice',
          type: 'number',
          required: true,
          admin: {
            description: 'Price per unit at time of booking',
          },
        },
      ],
    },
    {
      name: 'otherExtras',
      type: 'array',
      label: 'Additional Items',
      fields: [
        {
          name: 'name',
          type: 'text',
          required: true,
          label: 'Item Name',
        },
        {
          name: 'price',
          type: 'number',
          required: true,
          label: 'Unit Price',
          min: 0,
        },
        {
          name: 'quantity',
          type: 'number',
          required: true,
          label: 'Quantity',
          min: 1,
          defaultValue: 1,
        },
      ],
    },
    {
      name: 'coupon',
      type: 'relationship',
      relationTo: 'coupons',
      required: false,
      admin: {
        description: 'Optional. Select a coupon to apply its discount to the reservation total.',
      },
    },
    {
      name: 'couponCode',
      type: 'text',
      required: false,
      admin: {
        readOnly: true,
        description: 'Coupon code snapshot saved when the reservation is calculated.',
      },
    },
  ],
}
