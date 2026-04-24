import { NextResponse } from 'next/server'

const DEMO_TOKEN = 'demo-hookdrop-live-2024'

export async function POST(request: Request) {
  try {
    const body = await request.json()

    // Use server-side env var (no NEXT_PUBLIC_ prefix needed here)
    const ingestionUrl =
      process.env.INGESTION_URL ||
      process.env.NEXT_PUBLIC_INGESTION_URL ||
      'https://hookdropingestion-production.up.railway.app'

    console.log('Firing demo webhook to:', `${ingestionUrl}/in/${DEMO_TOKEN}`)

    const response = await fetch(`${ingestionUrl}/in/${DEMO_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const text = await response.text()
      console.error('Ingestion error:', response.status, text)
      return NextResponse.json(
        { error: `Ingestion returned ${response.status}` },
        { status: 500 }
      )
    }

    const data = await response.json()
    return NextResponse.json(data)
  } catch (error) {
    console.error('Demo fire error:', error)
    return NextResponse.json(
      { error: 'Failed to reach ingestion service' },
      { status: 500 }
    )
  }
}
