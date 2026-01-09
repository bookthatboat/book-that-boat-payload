import configPromise from '@payload-config'
import { getPayload } from 'payload'

export const maxDuration = 30

export const GET = async () => {
  const payload = await getPayload({
    config: configPromise,
  })

  const data = await payload.find({
    collection: 'users',
  })

  return Response.json(data)
}
