import type { Metadata } from 'next'
import configPromise from '@payload-config'
import { headers as getHeaders } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import ReservationDeskClient from '@/components/ReservationDesk/ReservationDeskClient'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Reservation Desk | Book That Boat Admin',
  icons: {
    icon: '/btb-admin-icon.svg',
    shortcut: '/btb-admin-icon.svg',
    apple: '/btb-admin-icon.svg',
  },
}

const ReservationDeskPage = async () => {
  const payload = await getPayload({ config: configPromise })
  const requestHeaders = await getHeaders()
  const authResult = await payload.auth({ headers: requestHeaders })

  if (!authResult.user) {
    redirect('/admin/login?redirect=/admin/reservation-desk')
  }

  return <ReservationDeskClient />
}

export default ReservationDeskPage
