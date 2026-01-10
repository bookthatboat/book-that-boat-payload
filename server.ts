import express from 'express'
import cors from 'cors'
import payload from 'payload'
import dotenv from 'dotenv'

dotenv.config()

const app = express()

// Initialize Payload first
const start = async () => {
  // Verify SendGrid config before initializing Payload
  /* if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) {
    throw new Error('Missing SendGrid configuration in .env file')
  } */

  await payload.init({
    // @ts-ignore
    secret: process.env.PAYLOAD_SECRET!,
    express: app,
    onInit: () => {
      payload.logger.info(`Email config: ${JSON.stringify(payload.email)}`)
    },
  })

  // Then apply CORS
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  )

  // @ts-ignore
  app.use('/api', payload.router)

  app.listen(3000, () => {
    console.log(`Payload CMS running on ${process.env.PAYLOAD_PUBLIC_SERVER_URL}`)
  })
}

start()
