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

export default buildConfig({
  cors: ['http://localhost:3000', process.env.FRONTEND_URL || ''],
  csrf: ['http://localhost:3000', process.env.FRONTEND_URL || ''],
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
