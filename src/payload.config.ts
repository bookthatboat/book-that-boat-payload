import { payloadCloudPlugin } from '@payloadcms/payload-cloud'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'path'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { mongooseAdapter } from '@payloadcms/db-mongodb'
import type { CORSConfig } from 'payload'

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

const FRONTEND_ORIGINS = [
  'https://book-that-boat-frontend.vercel.app',
  'https://bookthatboat.ae',
  'https://www.bookthatboat.ae',
  'http://localhost:3000',
]

const cors =
  process.env.NODE_ENV !== 'production'
    ? '*'
    : {
        origins: FRONTEND_ORIGINS,
        // Add any custom headers you actually send (Authorization, etc.)
        headers: ['authorization', 'content-type', 'x-requested-with'],
      }

export default buildConfig({
  serverURL: process.env.PAYLOAD_PUBLIC_SERVER_URL,
  cors,
  csrf: FRONTEND_ORIGINS,
  onInit: async (payload) => {
    // Start the payment polling when the server starts
    startPaymentPolling(payload)
  },
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
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
    connectOptions: {
      maxPoolSize: 1,
      minPoolSize: 0,
      maxIdleTimeMS: 10000,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 10000,
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
