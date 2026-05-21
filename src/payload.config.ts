import { payloadCloudPlugin } from '@payloadcms/payload-cloud'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { mongooseAdapter } from '@payloadcms/db-mongodb'

import { Reservations } from './collections/Reservations'
import { Owners } from './collections/Owners'
import { EventTypes } from './collections/EventTypes'
import { BoatTypes } from './collections/BoatTypes'
import { Boats } from './collections/Boats'
import { Extras } from './collections/Extras'
import { Hero } from './collections/Hero'
import { Media } from './collections/Media'
import { Menu } from './collections/Menu'
import { Footer } from './collections/Footer'
import { Users } from './collections/Users'
import { Locations } from './collections/Locations'
import { Routes } from './collections/Routes'
import { Reviews } from './collections/Reviews'
import { Coupons } from './collections/Coupons'
import { startPaymentPolling } from './collections/Reservations'
import { Subscribers } from './collections/Subscribers'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const codespaceName = process.env.CODESPACE_NAME
const codespaceDomain =
  process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'

const codespaceOrigin = codespaceName
  ? `https://${codespaceName}-3000.${codespaceDomain}`
  : ''

const allowedOrigins = [
  'http://localhost:3001',
  'http://localhost:3000',
  'https://bookthatboat.com',
  'https://www.bookthatboat.com',
  'https://book-that-boat-frontend.vercel.app',
  'https://book-that-boat-payload-production.up.railway.app',
  'https://bookings.bookthatboat.com',
  codespaceOrigin,
  process.env.PAYLOAD_PUBLIC_SERVER_URL || '',
].filter(Boolean)


const parseLengthFt = (value: unknown): number | undefined => {
  const raw = String(value ?? '').trim()
  const match = raw.match(/\d+(\.\d+)?/)

  if (!match) return undefined

  const length = Number(match[0])
  return Number.isFinite(length) ? length : undefined
}

export default buildConfig({
  serverURL:
    process.env.PAYLOAD_PUBLIC_SERVER_URL ||
    'https://book-that-boat-payload-production.up.railway.app',
  cors: allowedOrigins,
  csrf: allowedOrigins,
  onInit: async (payload) => {
    if (process.env.PAYMENT_POLLING_ENABLED === 'true') {
      startPaymentPolling(payload)
    }
  },
  admin: {
  user: Users.slug,
  importMap: {
    baseDir: path.resolve(dirname),
  },
  components: {
    afterNavLinks: ['/components/AdminNavLinks/BookingCalendarLink'],
  },
},
  endpoints: [
    {
      path: '/backfill-reservation-suppliers',
      method: 'post',
      handler: async (req) => {
        const secret = req.headers.get('x-backfill-secret')

        if (!process.env.BACKFILL_SECRET || secret !== process.env.BACKFILL_SECRET) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const payload = req.payload

        const reservations = await payload.find({
          collection: 'reservations',
          depth: 1,
          limit: 1000,
          overrideAccess: true,
        })

        let updated = 0
        const sampleResults: Array<{
          id: string
          boat?: string
          supplier?: string
        }> = []

        for (const reservation of reservations.docs as any[]) {
          const boatValue = reservation.boat
          const boatId =
            typeof boatValue === 'object'
              ? boatValue?.id
              : typeof boatValue === 'string'
                ? boatValue
                : null

          if (!boatId) continue

          const boat = await payload.findByID({
            collection: 'boats',
            id: boatId,
            depth: 0,
            overrideAccess: true,
          })

          const ownerValue = (boat as any)?.owner
          const supplierId =
            typeof ownerValue === 'object'
              ? ownerValue?.id
              : typeof ownerValue === 'string'
                ? ownerValue
                : null

          if (!supplierId) continue

          await payload.update({
            collection: 'reservations',
            id: reservation.id,
            data: {
              supplier: supplierId,
            },
            overrideAccess: true,
          })

          updated += 1

          if (sampleResults.length < 20) {
            sampleResults.push({
              id: reservation.id,
              boat: boatId,
              supplier: supplierId,
            })
          }
        }

        return Response.json({
          success: true,
          totalReservations: reservations.totalDocs,
          updated,
          sampleResults,
        })
      },
    },

    {
      path: '/backfill-boat-sort-fields',
      method: 'post',
      handler: async (req) => {
        const secret = req.headers.get('x-backfill-secret')

        if (!process.env.BACKFILL_SECRET || secret !== process.env.BACKFILL_SECRET) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const payload = req.payload

        const boats = await payload.find({
          collection: 'boats',
          depth: 0,
          limit: 1000,
          overrideAccess: true,
        })

        let updated = 0
        const results: Array<{
          id: string
          name?: string
          lengthRaw?: unknown
          lengthFt?: number
          reservationCount: number
        }> = []

        for (const boat of boats.docs as any[]) {
          const lengthRaw = boat.boatSpecifications?.length
          const lengthFt = parseLengthFt(lengthRaw)

          const reservations = await payload.find({
            collection: 'reservations',
            where: {
              boat: {
                equals: boat.id,
              },
            },
            depth: 0,
            limit: 0,
            overrideAccess: true,
          })

          const reservationCount = Number(reservations.totalDocs || 0)

          await payload.update({
            collection: 'boats',
            id: boat.id,
            data: {
              ...(typeof lengthFt === 'number' ? { lengthFt } : {}),
              reservationCount,
            },
            overrideAccess: true,
          })

          updated += 1

          results.push({
            id: boat.id,
            name: boat.name,
            lengthRaw,
            lengthFt,
            reservationCount,
          })
        }

        return Response.json({
          success: true,
          updated,
          results,
        })
      },
    },
  ],
  collections: [
    Reservations,
    Owners,
    Boats,
    EventTypes,
    BoatTypes,
    Extras,
    Hero,
    Media,
    Menu,
    Footer,
    Users,
    Routes,
    Locations,
    Reviews,
    Subscribers,
    Coupons,
  ],
  editor: lexicalEditor({}),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: mongooseAdapter({
    url: process.env.DATABASE_URI!,
    transactionOptions: false,
    connectOptions: {
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 60000,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    },
  }),
  sharp,
  plugins: [
    payloadCloudPlugin(),
    // storage-adapter-placeholder
  ],
  upload: {
    limits: {
      fileSize: 5000000, // 5MB
    },
  },
})
