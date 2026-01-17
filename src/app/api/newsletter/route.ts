import { NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@payload-config'

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://book-that-boat-frontend.vercel.app',
]

function corsHeaders(origin: string | null) {
  const o = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
  return {
    'Access-Control-Allow-Origin': o,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  }
}

// ✅ Preflight handler
export async function OPTIONS(req: Request) {
  const origin = req.headers.get('origin')
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin')

  try {
    const payload = await getPayload({ config })
    const { email } = await req.json()

    if (!email || !email.includes('@')) {
      return NextResponse.json(
        { error: 'Invalid email' },
        { status: 400, headers: corsHeaders(origin) },
      )
    }

    const normalized = email.toLowerCase().trim()

    const existing = await payload.find({
      collection: 'subscribers',
      where: { email: { equals: normalized } },
      limit: 1,
    })

    if (existing.docs.length > 0) {
      return NextResponse.json(
        { message: 'already' },
        { status: 200, headers: corsHeaders(origin) },
      )
    }

    await payload.create({
      collection: 'subscribers',
      data: { email: normalized },
    })

    return NextResponse.json(
      { message: 'success' },
      { status: 200, headers: corsHeaders(origin) },
    )
  } catch (err) {
    console.error('🔥 newsletter POST error:', err)
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500, headers: corsHeaders(origin) },
    )
  }
}
