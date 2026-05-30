import configPromise from '@payload-config'
import { headers as getHeaders } from 'next/headers'
import { redirect } from 'next/navigation'
import { getPayload } from 'payload'

import YachtDeskClient from '@/components/YachtDesk/YachtDeskClient'

export const dynamic = 'force-dynamic'

const YachtDeskPage = async () => {
  const payload = await getPayload({ config: configPromise })
  const requestHeaders = await getHeaders()
  const authResult = await payload.auth({ headers: requestHeaders })

  if (!authResult.user) {
    redirect('/admin/login?redirect=/admin/yacht-desk')
  }

  return <YachtDeskClient />
}

export default YachtDeskPage
