# Hookdropi

> Never lose a webhook. Never debug one in the dark.

Hookdrop is an AI-native webhook relay and inspector for developers. It captures every webhook permanently, forwards to any environment with auto-retry, and uses AI to explain payloads in plain English and write your handler code.

**Live at [hookdropi.vercel.app](https://hookdropi.vercel.app)**

![Hookdrop](apps/web/public/hookdroplogo.png)

---

## What it does

- **Permanent capture URL** — one URL that never changes or goes down. Every webhook is logged in full: headers, body, timestamp, source IP.
- **Auto-retry forwarding** — forward to localhost, staging, or production simultaneously. Automatic retries with exponential backoff: 5s → 30s → 2m → 10m → dead letter queue.
- **One-click replay** — replay any past event against any destination instantly. No more asking Stripe to resend.
- **Live event stream** — watch webhooks arrive in real time on your dashboard via WebSocket. No refreshing needed.
- **AI payload explanation** — AI reads every payload and explains what happened in plain English.
- **AI handler code generation** — generates complete, production-ready handler code in TypeScript, JavaScript, Python, or Go.
- **AI failure diagnosis** — when a delivery fails, AI tells you exactly why and how to fix it.
- **Plan limits enforced** — free tier gets 500 events/month. Paid plans enforced at the ingestion middleware level.

---

## Tech stack

| Layer            | Technology                                   |
| ---------------- | -------------------------------------------- |
| Ingestion API    | Node.js, TypeScript, Express                 |
| Delivery worker  | BullMQ, Redis                                |
| Dashboard API    | Node.js, TypeScript, Express, JWT            |
| Database         | PostgreSQL 16, TypeORM                       |
| Queue            | Redis, BullMQ                                |
| Frontend         | Next.js 16, Tailwind CSS, Zustand, Socket.io |
| AI               | Google Gemini (`gemini-3-flash-preview`)     |
| Email            | Resend                                       |
| Payments         | Paystack, Flutterwave                        |
| Error tracking   | Sentry                                       |
| Deployment       | Railway (backend), Vercel (frontend)         |
| Database hosting | Neon (PostgreSQL)                            |
| Redis hosting    | Upstash                                      |
| Documentation    | Mintlify                                     |

---

## Architecture

```
Internet
    │
    ▼
Ingestion API (port 3002)          ← captures webhooks in <50ms
    │
    ├── PostgreSQL (saves event)
    ├── Redis/BullMQ (enqueues job)
    └── Socket.io (emits to dashboard)

Delivery Worker
    │
    ├── Fetches event + destinations from Postgres
    ├── Forwards to each destination URL (10s timeout)
    ├── Retries: 5s → 30s → 2m → 10m → DLQ
    └── Logs every attempt to deliveries table

Dashboard API (port 3003)
    │
    ├── JWT authentication
    ├── CRUD: endpoints, events, destinations
    ├── AI routes: explain, schema, handler, diagnose
    └── Billing: Paystack + Flutterwave webhooks

Frontend (port 3004)
    │
    ├── Landing page
    ├── Auth (register, login)
    ├── Dashboard with real-time event stream
    ├── Event inspector with AI tab
    └── Billing page
```

---

## Database schema

| Table          | Purpose                                   |
| -------------- | ----------------------------------------- |
| `users`        | Accounts, plans, payment provider info    |
| `endpoints`    | Capture URLs with unique public tokens    |
| `events`       | Every captured webhook event              |
| `destinations` | Forwarding targets per endpoint           |
| `deliveries`   | Every delivery attempt with response logs |
| `ai_insights`  | Cached AI analysis per event              |

---

## Plans

| Plan    | Price      | Events/month | Retention | AI  |
| ------- | ---------- | ------------ | --------- | --- |
| Free    | ₦0         | 500          | 24 hours  | ✗   |
| Starter | ₦7,500/mo  | 10,000       | 7 days    | ✓   |
| Pro     | ₦19,000/mo | 100,000      | 30 days   | ✓   |
| Team    | ₦49,000/mo | 500,000      | 90 days   | ✓   |

---

## Getting started locally

### Prerequisites

- Node.js v20+
- PostgreSQL 16+
- Redis 7+

### Clone and install

```bash
git clone https://github.com/bobprince4u/hookdrop.git
cd hookdrop
npm install
```

### Set up environment variables

```bash
cp .env.example .env
```

Fill in your values. Required variables:

```env
# Database
DATABASE_URL=postgresql://postgres:password@localhost:5432/hookdrop

# Redis
REDIS_URL=redis://localhost:6379

# Auth
JWT_SECRET=your-long-random-secret-here
REFRESH_TOKEN_SECRET=your-another-long-random-secret
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=30d

# AI
GEMINI_API_KEY=your-gemini-api-key

# Email
RESEND_API_KEY=your-resend-api-key

# Payments
PAYSTACK_SECRET_KEY=sk_test_your-paystack-key
PAYSTACK_PUBLIC_KEY=pk_test_your-paystack-key
FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-your-flutterwave-key
FLUTTERWAVE_PUBLIC_KEY=FLWPUBK_TEST-your-flutterwave-key
FLUTTERWAVE_ENCRYPTION_KEY=your-encryption-key

# App
FRONTEND_URL=http://localhost:3004
NODE_ENV=development
PAYMENT_MODE=test
DEFAULT_PAYMENT_PROVIDER=paystack
ADMIN_EMAIL=your-email@example.com
```

### Run database migrations

```bash
npm run migrate:up
```

### Start all services

Open four terminal tabs:

```bash
# Terminal 1 — Ingestion API
cd apps/ingestion && npm run dev

# Terminal 2 — Delivery Worker
cd apps/worker && npm run dev

# Terminal 3 — Dashboard API
cd apps/api && npm run dev

# Terminal 4 — Frontend
cd apps/web && npm run dev -- -p 3004
```

Open `http://localhost:3004` in your browser.

### Run the test script

Fire 100 test webhooks to verify everything is working:

```bash
TEST_TOKEN=your-endpoint-token npm run test:ingestion
```

---

## Project structure

```
hookdrop/
├── apps/
│   ├── ingestion/          — webhook capture service (port 3002)
│   │   └── src/
│   │       ├── routes/     — POST/GET /in/:token
│   │       ├── middleware/ — rate limiting
│   │       └── entities/   — TypeORM entities
│   ├── worker/             — BullMQ delivery worker
│   │   └── src/
│   │       ├── workers/    — delivery processor
│   │       └── services/   — email notifications
│   ├── api/                — dashboard REST API (port 3003)
│   │   └── src/
│   │       ├── controllers/ — auth, endpoints, events, billing, AI
│   │       ├── middleware/  — JWT auth, plan limits
│   │       ├── routes/      — API router
│   │       └── services/   — payments, email
│   └── web/                — Next.js frontend (port 3004)
│       └── app/
│           ├── page.tsx            — landing page
│           ├── auth/               — login, register
│           └── dashboard/          — main app
│               ├── page.tsx        — endpoints list
│               ├── endpoints/[id]/ — events + AI inspector
│               ├── billing/        — plans + payment
│               └── settings/       — account settings
├── docs/                   — Mintlify documentation
├── migrations/             — PostgreSQL migrations
├── scripts/                — test scripts
└── .env.example            — environment variable template
```

---

## API overview

### Authentication

```bash
POST /api/auth/register   — create account
POST /api/auth/login      — get JWT tokens
POST /api/auth/refresh    — refresh access token
```

### Endpoints

```bash
GET    /api/endpoints           — list endpoints
POST   /api/endpoints           — create endpoint
GET    /api/endpoints/:id       — get endpoint
DELETE /api/endpoints/:id       — delete endpoint
```

### Events

```bash
GET  /api/endpoints/:id/events                    — list events
GET  /api/endpoints/:id/events/:eId               — get event
POST /api/endpoints/:id/events/:eId/replay        — replay event
```

### AI (paid plans only)

```bash
GET  /api/endpoints/:id/events/:eId/ai/explain    — explain payload
GET  /api/endpoints/:id/events/:eId/ai/schema     — generate TypeScript interface
POST /api/endpoints/:id/events/:eId/ai/handler    — generate handler code
GET  /api/endpoints/:id/events/:eId/ai/diagnose   — diagnose failure
```

### Billing

```bash
GET  /api/billing/plans         — list plans
GET  /api/billing/current       — get current plan
POST /api/billing/initialize    — start payment
POST /api/billing/webhook       — payment webhook (Paystack/Flutterwave)
GET  /api/billing/mode          — test or live mode
```

---

## Deployment

### Railway (backend)

Each service deploys independently on Railway. Set the following environment variables per service:

**All services:** `DATABASE_URL`, `REDIS_URL`, `NODE_ENV`, `SENTRY_DSN`

**API only:** all remaining variables from `.env.example`

```bash
# Deploy each service
cd apps/api && railway up --service hookdrop-api
cd apps/ingestion && railway up --service hookdrop-ingestion
cd apps/worker && railway up --service hookdrop-worker
```

### Vercel (frontend)

```bash
cd apps/web
vercel --prod
```

Set these environment variables in Vercel:

```
NEXT_PUBLIC_API_URL=https://your-api.railway.app
NEXT_PUBLIC_INGESTION_URL=https://your-ingestion.railway.app
```

---

## Going live checklist

- [ ] Complete Paystack business verification (BVN + government ID + proof of address)
- [ ] Get Flutterwave live keys from dashboard
- [ ] Set `PAYMENT_MODE=live` in Railway environment variables
- [ ] Update `PAYSTACK_SECRET_KEY` and `FLUTTERWAVE_SECRET_KEY` to live keys
- [ ] Set webhook URLs in Paystack and Flutterwave dashboards
- [ ] Add custom domain in Railway and Vercel
- [ ] Update `FRONTEND_URL` to your real domain
- [ ] Verify UptimeRobot is monitoring `/health` endpoints
- [ ] Confirm Sentry is receiving errors

---

## Documentation

Full documentation at **[bobprince.mintlify.app](https://bobprince.mintlify.app)**

- [Quickstart — first webhook in 5 minutes](https://bobprince.mintlify.app/quickstart)
- [How it works](https://bobprince.mintlify.app/how-it-works)
- [API reference](https://bobprince.mintlify.app/api-reference/authentication)
- [Stripe guide](https://bobprince.mintlify.app/providers/stripe)
- [GitHub guide](https://bobprince.mintlify.app/providers/github)
- [Paystack guide](https://bobprince.mintlify.app/providers/paystack)
- [Self-hosting guide](https://bobprince.mintlify.app/self-hosting)

---

## Contributing

Pull requests are welcome. For major changes please open an issue first.

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes: `git commit -m 'feat: add your feature'`
4. Push to the branch: `git push origin feat/your-feature`
5. Open a pull request

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

Built with ❤️ in Nigeria 🇳🇬
