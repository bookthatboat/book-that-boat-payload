import express from 'express'
import cors from 'cors'
import payload from 'payload'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
app.set('trust proxy', 1)

const allowedOrigins = [process.env.CORS_ORIGIN].filter(Boolean) as string[]

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true) // server-to-server
    if (allowedOrigins.includes(origin)) return cb(null, true)
    return cb(new Error(`CORS blocked for origin: ${origin}`))
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
}

app.use(cors(corsOptions))
app.options('*', cors(corsOptions))

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
  app.listen(port, () => console.log(`Payload CMS running on port ${port}`))
}

start()
