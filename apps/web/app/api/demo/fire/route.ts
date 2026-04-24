import { NextResponse } from 'next/server'

const INGESTION_URL =
  process.env.NEXT_PUBLIC_INGESTION_URL ||
  'https://hookdropingestion-production.up.railway.app'
const DEMO_TOKEN = 'demo-hookdrop-live-2024'

export async function POST(request: Request) {
  try {
    const body = await request.json()

    const response = await fetch(`${INGESTION_URL}/in/${DEMO_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Demo fire error:', error)
    return NextResponse.json(
      { error: 'Failed to fire webhook' },
      { status: 500 }
    )
  }
}
