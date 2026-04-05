import axios from 'axios'

const INGESTION_URL = process.env.INGESTION_URL || 'http://localhost:3002'
const TOKEN = process.env.TEST_TOKEN || 'test-token-abc123'
const TOTAL = 100

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function fireWebhooks() {
  console.log(`Firing ${TOTAL} webhooks at ${INGESTION_URL}/in/${TOKEN}`)
  console.log('─'.repeat(50))

  let success = 0
  let failed = 0
  const start = Date.now()

  const promises = Array.from({ length: TOTAL }, (_, i) =>
    axios.post(
      `${INGESTION_URL}/in/${TOKEN}`,
      {
        test: true,
        index: i + 1,
        timestamp: new Date().toISOString(),
        type: 'test.event',
        data: { amount: Math.floor(Math.random() * 10000), currency: 'NGN' },
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5000 }
    )
      .then(() => { success++; process.stdout.write('.') })
      .catch(() => { failed++; process.stdout.write('x') })
  )

  await Promise.all(promises)
  const duration = Date.now() - start

  console.log('\n' + '─'.repeat(50))
  console.log(`✓ Success: ${success}/${TOTAL}`)
  console.log(`✗ Failed:  ${failed}/${TOTAL}`)
  console.log(`⏱ Duration: ${duration}ms`)
  console.log(`⚡ Average: ${Math.round(duration / TOTAL)}ms per request`)
  console.log('─'.repeat(50))
  console.log('Now check your events table in DBeaver:')
  console.log(`SELECT COUNT(*) FROM events WHERE received_at > NOW() - INTERVAL '1 minute';`)
}

fireWebhooks().catch(console.error)
