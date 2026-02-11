import type { CollectionConfig } from 'payload'
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
type PaymentKind = 'full' | 'downpayment' | 'installment'

interface Reservation {
  id: string
  status: ReservationStatus
  user: string | User
  boat: string | Boat
  startTime: Date | string
  endTime: Date | string
  totalPrice: number
  paymentMethod?: 'full' | 'installments'
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
    status: 'pending' | 'completed' | 'failed' | 'refunded'
    installmentStage?: InstallmentStage
    createdAt?: string
    installedAt?: string
    paidAt?: string
    balance: number
    notes: string
    paymentLink?: string
    paymentLinkId?: string
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
  } catch (e) {
    console.error('Error running initial installment scheduler:', e)
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
    () => checkDueInstallments(payload),
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
          { status: { equals: 'awaiting payment' } },
          { paymentMethod: { equals: 'installments' } },
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
      where: { status: { equals: 'awaiting payment' } },
      depth: 0,
      overrideAccess: true,
    })

    console.log(`Found ${reservations.docs.length} reservations awaiting payment`)

    // Throttle checks per paymentLinkId to avoid MamoPay 429
    const CHECK_THROTTLE_MS = isProduction ? 60 * 1000 : 20 * 1000

    for (const reservation of reservations.docs as any[]) {
      try {
        const reservationId = String(reservation?.id || '')
        if (!reservationId) continue

        const payments = Array.isArray(reservation.payments) ? reservation.payments : []
        const isInstallments = reservation.paymentMethod === 'installments'

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

          const allPaid = updatedPayments.every((pp: any) => pp?.status === 'completed')

          // ✅ Retry-safe update (prevents WriteConflict from “breaking” a reservation forever)
          try {
            await withWriteConflictRetry(() =>
              payload.update({
                collection: 'reservations',
                id: reservationId,
                data: {
                  payments: updatedPayments,
                  status: allPaid ? 'confirmed' : 'awaiting payment',
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

    await sendEmailViaGraph({ to, subject, html })
    console.log('Email sent successfully via Microsoft Graph')
  } catch (error) {
    console.error('Error sending email via Microsoft Graph:', error)
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
        `Booking ${formatDateSafe(reservation.startTime)} to ${formatDateSafe(reservation.endTime)}, ${bookingId}`.substring(
          0,
          75,
        ),
      amount: amount,
      amount_currency: 'AED',
      return_url: `${APP_URLS.frontend}/payment-success`,
      failure_return_url: `${APP_URLS.frontend}/payment-failure`,
      active: true,
      processing_fee_percentage: 4,
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
      const start = new Date(reservation.startTime)
      const end = new Date(reservation.endTime)

      const dateStr = start.toLocaleDateString('en-GB')
      const timeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

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
      const start = new Date(reservation.startTime)
      const end = new Date(reservation.endTime)

      const dateStr = start.toLocaleDateString('en-GB')
      const timeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

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
        (boat as any)?.meetingPoint?.name || (boat as any)?.meetingPointName || departureLocation

      const meetingPointLink =
        (boat as any)?.meetingPoint?.url ||
        (boat as any)?.meetingPointUrl ||
        (boat as any)?.meetingPointLink ||
        ''

      const parkingName =
        (boat as any)?.parking?.name || (boat as any)?.parkingLocation || 'Dubai Marina'

      const parkingLink =
        (boat as any)?.parking?.url || (boat as any)?.parkingUrl || (boat as any)?.parkingLink || ''

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
      const start = new Date(reservation.startTime)
      const end = new Date(reservation.endTime)

      const dateStr = start.toLocaleDateString('en-GB')
      const timeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

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
      const start = new Date(reservation.startTime)
      const end = new Date(reservation.endTime)

      const dateStr = start.toLocaleDateString('en-GB')
      const timeStr = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })

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
      const paymentLink = (reservation.paymentLink || '#').trim()

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
                      <td style="padding:12px 12px;background:#ffffff;color:#ef6c00;font-weight:900;">${totalPriceStr}</td>
                    </tr>
                  </table>
                </div>
        
                <div style="margin-top:16px;padding:14px 14px;border-radius:12px;background:#fff7ed;border:1px solid #fed7aa;">
                  <p style="margin:0;font-size:13px;line-height:1.7;color:#374151;">
                    Please complete your payment using the button below. Once payment is received, your booking will be confirmed immediately.
                  </p>
                </div>
        
                <div style="text-align:center;margin:18px 0 6px 0;">
                  <a
                    href="${paymentLink}"
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
            <p><strong>Dates:</strong> ${safeFormatDate(reservation.startTime)} - ${safeFormatDate(reservation.endTime)}</p>
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

const createInstallmentPlan = async (
  reservation: Reservation,
  boat: Boat,
  user: User,
  payload: any,
) => {
  const numberOfInstallmentsRaw = Number(reservation.numberOfInstallments ?? 3)
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

    const dueDate = new Date(now)
    dueDate.setDate(dueDate.getDate() + (i + 1) * 30) // 30-day intervals

    payments.push({
      id: `installment-${i + 1}-${Date.now()}`,
      kind: 'installment',
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
      notes: `Installment ${i + 1} of ${installmentAmounts.length}`,
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

export const Reservations: CollectionConfig = {
  slug: 'reservations',
  admin: {
    defaultColumns: ['transactionId', 'boat', 'user', 'status', 'startTime', 'endTime'],
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
        async ({ data, operation, originalDoc }) => {
        // Only applies on update where status is changing
        const prevStatus = (originalDoc as any)?.status
        const nextStatus = (data as any)?.status
      
        const isPendingToAwaiting =
          operation === 'update' && prevStatus === 'pending' && nextStatus === 'awaiting payment'
      
        if (!isPendingToAwaiting) return data
      
        const meetingPointName = String((data as any)?.meetingPointName || (originalDoc as any)?.meetingPointName || '').trim()
        const meetingPointPin = String((data as any)?.meetingPointPin || (originalDoc as any)?.meetingPointPin || '').trim()
        const contactPersonName = String((data as any)?.contactPersonName || (originalDoc as any)?.contactPersonName || '').trim()
        const contactPersonNumber = String((data as any)?.contactPersonNumber || (originalDoc as any)?.contactPersonNumber || '').trim()
        const parkingLocationName = String((data as any)?.parkingLocationName || (originalDoc as any)?.parkingLocationName || '').trim()
        const parkingLocationPin = String((data as any)?.parkingLocationPin || (originalDoc as any)?.parkingLocationPin || '').trim()
      
        const missing: string[] = []
        if (!meetingPointName) missing.push('Meeting Point - Name')
        if (!meetingPointPin) missing.push('Meeting Point - Google Maps Pin')
        if (!contactPersonName) missing.push('Contact Person - Name')
        if (!contactPersonNumber) missing.push('Contact Person - Number')
        if (!parkingLocationName) missing.push('Car Parking Location - Name')
        if (!parkingLocationPin) missing.push('Car Parking Location - Google Maps Pin')
      
        if (missing.length) {
          throw new Error(
            `Cannot change status from "pending" to "awaiting payment" until these fields are completed: ${missing.join(', ')}`,
          )
        }
      
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
                })
                boatPrice = boat.price
                boatPriceDay = boat.priceDay
                data.boatHourlyPrice = boatPrice
                data.boatDailyPrice = boatPriceDay

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
    ],
    afterChange: [
      async ({ doc: untypedDoc, previousDoc: untypedPreviousDoc, operation, req }) => {
        const doc = untypedDoc as Reservation
        const previousDoc = untypedPreviousDoc as Reservation | undefined

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

        // Check if we need to process status changes
        const shouldProcessStatusChange =
          operation === 'create' || (operation === 'update' && doc.status !== previousDoc?.status)

        // Check if we need to process payment link creation
        const shouldProcessPaymentLink =
          doc.status === 'awaiting payment' &&
          (!previousDoc || previousDoc.status !== 'awaiting payment')

        // Don't process if this is a payment confirmation (handled by polling)
        const isPaymentConfirmation =
          !req.user && previousDoc?.status === 'awaiting payment' && doc.status === 'confirmed'

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
          })) as unknown as Boat

          const user = {
            name: doc.guestName || (typeof doc.user === 'string' ? doc.user : '') || 'Guest',
            email: doc.guestEmail || '',
          } as unknown as User

          if (!boat) {
            console.error('Missing boat data')
            return
          }

          // Create payment plan if status changed to 'awaiting payment'
          if (shouldProcessPaymentLink) {
            try {
              // Check if this is an installment payment or single payment
              const useInstallments = doc.paymentMethod === 'installments'

              if (useInstallments) {
                // Create installment plan (down payment link now + scheduled installments later)
                const payments = await createInstallmentPlan(doc, boat, user, payload)

                const down = payments?.[0]

                // Update reservation with payment plan + expose the down payment link at top-level fields
                await payload.update({
                  collection: 'reservations',
                  id: doc.id,
                  data: {
                    payments,
                    paymentLink: down?.paymentLink || '',
                    paymentLinkId: down?.paymentLinkId || '',
                  },
                  overrideAccess: true,
                })

                // Send down payment email
                if (payments && payments.length > 0) {
                  await sendInstallmentEmail(
                    user,
                    boat,
                    doc,
                    1,
                    payments.length,
                    payments[0].amount,
                    payments[0].paymentLink || '',
                    payments[0].date,
                  )
                }

                startPaymentPolling(payload)
                doc.payments = payments
                doc.paymentLink = down?.paymentLink || ''
                doc.paymentLinkId = down?.paymentLinkId || ''
                return doc
              } else {
                // Original single payment logic
                const paymentLink = await createMamoPaymentLink(doc, boat, user)

                if (paymentLink) {
                  // Update reservation with payment link
                  const payments = [
                    {
                      id: `payment-${Date.now()}`,
                      kind: 'full',
                      installmentStage: 'installed_ready_to_be_paid',
                      createdAt: new Date().toISOString(),
                      installedAt: new Date().toISOString(),
                      paidAt: '',
                      amount: doc.totalPrice,
                      method: doc.method || 'Mamo Pay',
                      date: new Date().toISOString(),
                      status: 'pending',
                      balance: 0,
                      paymentLink: paymentLink.url,
                      paymentLinkId: paymentLink.id,
                      notes: 'Full payment',
                    },
                  ] satisfies NonNullable<Reservation['payments']>

                  await withWriteConflictRetry(() =>
                    req.payload.update({
                      collection: 'reservations',
                      id: doc.id,
                      data: {
                        paymentLink: paymentLink.url,
                        paymentLinkId: paymentLink.id,
                        payments,
                      },
                      overrideAccess: true,
                    }),
                  )

                  startPaymentPolling(payload)

                  // Send awaiting payment email
                  if (user.email) {
                    await sendEmail(
                      user.email,
                      `Book That Boat - Yacht Rental Dubai - Booking #${doc.transactionId || doc.id}`,
                      getStatusEmailContent('user', 'awaiting payment', boat, user, {
                        ...doc,
                        paymentLink: paymentLink.url,
                      }),
                    )
                  }

                  await sendEmail(
                    EMAIL_CONFIG.adminEmail,
                    '[Admin] Payment Required for Booking',
                    getStatusEmailContent('admin', 'awaiting payment', boat, user, {
                      ...doc,
                      paymentLink: paymentLink.url,
                    }),
                  )

                  doc.paymentLink = paymentLink.url
                  doc.paymentLinkId = paymentLink.id
                  doc.payments = payments
                  return doc
                } else {
                  console.warn('Payment link was not created')
                }
              }
            } catch (error) {
              console.error('Error creating payment plan:', error)
            }
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
        }
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
      label: 'Payment Method',
      options: [
        { label: 'Full Payment', value: 'full' },
        { label: 'Installments', value: 'installments' },
      ],
      defaultValue: 'full',
      required: true,
      admin: {
        position: 'sidebar',
      },
    },
    {
      name: 'numberOfInstallments',
      type: 'number',
      label: 'Number of Installments',
      required: false,
      defaultValue: 3,
      admin: {
        position: 'sidebar',
        condition: (data) => data?.paymentMethod === 'installments',
        description: 'Number of installments AFTER the down payment (e.g. 1, 2, 3, 4)',
      },
    },
    {
      name: 'downPaymentAmount',
      type: 'number',
      label: 'Down Payment Amount (AED)',
      required: false,
      admin: {
        position: 'sidebar',
        condition: (data) => data?.paymentMethod === 'installments',
        description:
          'Optional. If empty, the system defaults to an even split across (installments + 1).',
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
      options: ['pending', 'confirmed', 'cancelled', 'awaiting payment'].map((option) => ({
        label: option.charAt(0).toUpperCase() + option.slice(1),
        value: option,
      })),
      defaultValue: 'pending',
    },
    {
      name: 'paymentLinkId',
      type: 'text',
      label: 'Payment Link ID',
      admin: {
        readOnly: true,
        condition: (data) => data?.status !== 'pending',
      },
    },
    {
      name: 'paymentLink',
      type: 'text',
      label: 'Payment Link',
      admin: {
        readOnly: true,
        condition: (data) => data?.status !== 'pending',
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
      label: 'Payment Method',
      options: ['Mamo Pay', 'Bank Transfer', 'Cash'],
      required: true,
    },
    {
      name: 'payments',
      type: 'array',
      label: 'Payments',
      admin: {
        description: 'Instalment of all payments made for this reservation',
        initCollapsed: true,
        condition: (data) => data?.paymentMethod === 'installments',
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
          name: 'date',
          type: 'date',
          label: 'Payment Date',
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
            { label: 'Pending', value: 'pending' },
            { label: 'Completed', value: 'completed' },
            { label: 'Failed', value: 'failed' },
            { label: 'Refunded', value: 'refunded' },
          ],
          defaultValue: 'pending',
          required: true,
        },
        {
          name: 'balance',
          type: 'number',
          label: 'Remaining Balance',
          admin: {
            description: 'Balance remaining after this payment',
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
        position: 'sidebar',
        description: 'Applied coupon for this reservation (set from frontend)',
      },
    },
    {
      name: 'couponCode',
      type: 'text',
      required: false,
      admin: {
        position: 'sidebar',
        readOnly: true,
        description: 'Coupon code snapshot at time of booking',
      },
    },
  ],
}
