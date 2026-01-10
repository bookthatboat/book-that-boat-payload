import express from 'express'
import cors from 'cors'
import payload from 'payload'
import dotenv from 'dotenv'

dotenv.config()

const app = express()

// IMPORTANT for Railway / proxies
app.set('trust proxy', 1)

// Put CORS BEFORE payload.init so it applies to Payload routes + OPTIONS preflight
const allowedOrigins = [
  process.env.CORS_ORIGIN, // e.g. https://book-that-boat-frontend.vercel.app
].filter(Boolean) as string[]

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server + same-origin (no Origin header)
      if (!origin) return cb(null, true)

      if (allowedOrigins.includes(origin)) return cb(null, true)

      return cb(new Error(`CORS blocked for origin: ${origin}`))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  }),
)

// (optional but recommended)
app.options('*', cors())

const start = async () => {
  await payload.init({
    // @ts-ignore
    secret: process.env.PAYLOAD_SECRET!,
    express: app,
    onInit: () => {
      payload.logger.info('Payload initialized')
    },
  })

  // ❌ REMOVE THIS LINE — Payload already mounts routes on your express app
  // app.use('/api', payload.router)

  const port = Number(process.env.PORT) || 3000
  app.listen(port, () => {
    console.log(`Payload CMS running on port ${port}`)
  })
}

start()
