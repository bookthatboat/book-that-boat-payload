import { NextResponse } from 'next/server'
import { getPayload } from 'payload'
import config from '@payload-config'

export async function POST(req: Request) {
  try {
    const payload = await getPayload({ config })
    const { email } = await req.json()

    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 })
    }

    const normalized = email.toLowerCase().trim()

    const existing = await payload.find({
      collection: 'subscribers',
      where: { email: { equals: normalized } },
      limit: 1,
    })

    if (existing.docs.length > 0) {
      return NextResponse.json({ message: 'already' })
    }

    await payload.create({
      collection: 'subscribers',
      data: { email: normalized },
    })

    return NextResponse.json({ message: 'success' })
  } catch (err) {
    console.error('🔥 newsletter POST error:', err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
