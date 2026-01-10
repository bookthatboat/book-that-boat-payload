import express from 'express'
import cors from 'cors'
import payload from 'payload'
import dotenv from 'dotenv'

dotenv.config()

const app = express()

// IMPORTANT for Railway / proxies
app.set('trust proxy', 1)

const allowedOrigins = [
  process.env.FRONTEND_URL?.trim(),              // recommended
  process.env.CORS_ORIGIN?.trim(),               // your existing var
  process.env.PAYLOAD_PUBLIC_SERVER_URL?.trim(), // CMS URL (optional but ok)
].filter(Boolean) as string[]

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    // allow server-to-server + health checks (no Origin header)
    if (!origin) return cb(null, true)

    if (allowedOrigins.includes(origin)) return cb(null, true)

    return cb(new Error(`CORS blocked for origin: ${origin}`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'x-payload-csrf',
    'x-csrf-token',
  ],
  optionsSuccessStatus: 204,
}

// ✅ Put CORS BEFORE payload.init so it applies to Payload routes + preflight
app.use(cors(corsOptions))
app.options('*', cors(corsOptions)) // ✅ NOT cors() default

const start = async () => {
  await payload.init({
    // @ts-ignore
    secret: process.env.PAYLOAD_SECRET!,
    express: app,
    onInit: () => {
      payload.logger.info('Payload initialized')
    },
  })

  const port = Number(process.env.PORT) || 3000
  app.listen(port, () => {
    console.log(`Payload CMS running on port ${port}`)
  })
}

start()
