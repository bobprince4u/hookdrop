# Hookdrop hardening

Operator and integrator reference for the security-relevant behaviour of this codebase.

This document exists because the remediation of a 49-finding audit (`H-01` … `H-49`) left its
reasoning almost entirely in code comments, where an operator deciding whether to set a
variable or an integrator writing a signature check will never find it. Anything here that
describes a mechanism describes code in this repository; anything not yet implemented is in
[Known gaps](#known-gaps) rather than described in the present tense.

Sections that other files link to by name:

- [Verifying deliveries](#verifying-deliveries) — cited by `apps/worker/src/services/signature.service.ts`
- [Unknown-token floods](#known-gaps) — cited by `apps/ingestion/src/middleware/resolveEndpoint.ts`

[Draining the retired Redis queues](#draining-the-retired-redis-queues) is a one-time
procedure for anyone upgrading across the pg-boss migration. No code cites it; it is here
because the keys it removes are invisible from the application after the upgrade.

---

## Contents

1. [Configuration and secrets](#configuration-and-secrets)
2. [Authentication](#authentication)
3. [Verifying deliveries](#verifying-deliveries)
4. [Outbound delivery safety](#outbound-delivery-safety)
5. [Inbound payment webhooks](#inbound-payment-webhooks)
6. [Tenant isolation](#tenant-isolation)
7. [Rate limiting](#rate-limiting)
8. [Event retention](#event-retention)
9. [Queues](#queues)
10. [Logging discipline](#logging-discipline)
11. [Operational procedures](#operational-procedures)
12. [Known gaps](#known-gaps)

---

## Configuration and secrets

All three Node services validate their environment with Zod at import and call
`process.exit(1)` on a missing or malformed required value, naming the variable and the reason
and never echoing the value. One `.env` at the repository root serves all four apps; each
service finds it by walking up from its own directory rather than resolving against
`process.cwd()`, so it works under any process manager (H-44).

`.env.example` is the authoritative list. The rules worth knowing:

| Rule | Why |
| --- | --- |
| `JWT_SECRET` and `REFRESH_TOKEN_SECRET` are required, ≥ 32 chars in production, and must differ from each other | Sharing one secret means a refresh token verifies as an access token. Known placeholders (`secret`, `changeme`, the two former hardcoded fallbacks) are rejected outright (H-01). |
| `DATABASE_URL` is required by all three services, with no localhost default | It is now both the data store and the job queue, so a wrong value cannot degrade to "accepted and never delivered" — the write and the delivery job commit together or not at all. |
| `REDIS_URL` is required by `api` and `ingestion`, and unused by `worker` | A missing `REDIS_URL` used to mean events were accepted and never delivered, with nothing in the logs (H-09). The queue moved to Postgres, so that failure mode is gone, but Redis still backs the Socket.IO adapter and the rate limiters — a service that cannot reach it cannot enforce a limit, which is a different reason to refuse to boot. The worker holds no Redis connection of any kind and the variable is absent from its schema. |
| `EMAIL_FROM` is required in production, and `onboarding@resend.dev` is rejected there | That address is Resend's shared sandbox sender: it only delivers to the account owner, so every customer email was silently dropped (H-31). |
| `TRUST_PROXY_HOPS` is a hop count, not a boolean | `trust proxy: true` lets any client forge `X-Forwarded-For` and walk past every rate limiter; unset buckets the entire internet into one key (H-19). |
| A configured payment provider must have its verification secret in production | Both providers fail closed on a missing secret, so the failure mode is "payment taken, plan never granted" — worse than refusing to boot. |

Two variables warn rather than block, both in production only: a payment provider without a
webhook secret, and `API_KEY_SECRET` unset. Warnings name the variable and the consequence.

### Rotation semantics

| Rotate | Invalidates |
| --- | --- |
| `JWT_SECRET` | Every access token. Sessions recover on the next refresh call. |
| `REFRESH_TOKEN_SECRET` | Every session, and — **if `API_KEY_SECRET` is unset** — every customer API key, because the key pepper is then derived from it. |
| `API_KEY_SECRET` | Every API key, and nothing else. |

Setting `API_KEY_SECRET` is what decouples the second row from the third. It costs one variable
and is worth doing before an incident rather than during one.

---

## Authentication

Three credential types, all presented as `Authorization: Bearer <value>`.

### Access token

A short-lived JWT (`ACCESS_TOKEN_TTL`, default 15 minutes) carrying `id`, `email` and `plan`.
Verification rejects refresh tokens and tokens issued for another audience. Claims are treated
as identity, never as entitlement: any handler that makes a plan decision runs
`loadCurrentUser`, which reads the authoritative row and resolves the effective plan through
`plan_expires_at`. A token issued while a subscription was live does not outlive the
subscription by its own TTL.

### Refresh token

Opaque random bytes, delivered in an httpOnly cookie and never exposed to JavaScript. Only
`HMAC-SHA256(token, REFRESH_TOKEN_SECRET)` is stored, so a database dump yields no usable
session. Rotation is single-use: refreshing revokes the presented token and issues a new one,
and presenting an already-used token revokes the entire family for that account on the
assumption it was stolen (H-16). `POST /api/auth/logout` is deliberately unauthenticated —
requiring a valid *access* token would mean an expired session could not be logged out, which
is exactly when a user wants to.

### API key (H-27)

    hdk_<43 url-safe base64 characters>

32 random bytes behind a recognisable label. Issued once, by `POST /api/keys`, and returned in
that response only — no endpoint can retrieve it again. Stored as
`HMAC-SHA256(key, pepper)`, hex, on a `UNIQUE` column, so verification is one indexed lookup;
the `prefix` column holds the first 12 characters for display and is not a credential. Keys
may carry an expiry (up to 730 days) and are revocable individually; at most 10 active keys
per account.

This replaces the settings page's "Copy API token" button, which handed out the raw access
JWT from `localStorage`. That credential could not be revoked without rotating `JWT_SECRET`
for every user, and H-16's 15-minute lifetime broke it outright.

**An API key is not a session.** `authenticate` accepts both shapes and populates the same
`req.user`, so every existing authorization check works unchanged — but `denyApiKeyAuth`
refuses keys on the routes where possession of a long-lived integration credential must not be
enough:

| Route | Why |
| --- | --- |
| `POST /api/auth/logout-all` | Revoking every session is an account-recovery action. |
| `POST /api/keys`, `GET /api/keys`, `DELETE /api/keys/:id` | A key must not mint a successor, revoke a sibling, or enumerate the account's credentials. Without this, revoking a leaked key does not end the access — whoever holds it issues a replacement first. |
| `POST /api/billing/initialize` | Money. Initiated by a person choosing a plan, never by an integration. |
| `POST /api/admin/upgrade-user` | Granting plan time is giving away paid service. |

The read-only admin routes accept either credential: a key that can read the admin dashboard
can already read everything the account owns.

Rejections are uniform. Unknown, revoked, and expired keys all answer
`401 {"error":"Invalid API key","code":"invalid_api_key"}`, and a revocation that matches
nothing answers `404` whether the key belongs to someone else or was already revoked — neither
response can be used to enumerate. A database failure during key verification answers `503`,
not `401`: telling a client its valid key is invalid sends it to rotate a credential that was
fine.

`last_used_at` is updated at most once every five minutes per key, so the answer to "is
anything still using this?" does not cost a write on every request.

---

## Verifying deliveries

Every delivery to a destination that has a `secret` configured is signed. Destinations without
one are sent unsigned; configuring a secret is what turns signing on.

    X-Hookdrop-Timestamp: 1718000000
    X-Hookdrop-Signature: v1=<hex HMAC-SHA256>

The signed string is `timestamp` + `.` + `raw request body`, keyed by your destination secret.

Three properties to preserve when you implement the check:

1. **Verify against the raw body, not a re-serialised object.** Any JSON round-trip can change
   key order or whitespace and will break the MAC.
2. **The timestamp is inside the signed string.** That is what makes replay detection possible:
   with a detached timestamp, a captured delivery could be resent forever with a fresh
   timestamp and an unchanged, still-valid signature. Reject anything outside a few minutes of
   your own clock.
3. **Compare in constant time, after a length check.** `crypto.timingSafeEqual` throws on
   length mismatch rather than returning false.

```js
// Express. Note express.raw(), not express.json().
app.post('/hook', express.raw({ type: '*/*' }), (req, res) => {
  const timestamp = req.get('X-Hookdrop-Timestamp')
  const presented = req.get('X-Hookdrop-Signature')

  if (!timestamp || !presented) return res.status(400).send('missing signature headers')

  // Bound replay: reject anything older than five minutes.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    return res.status(400).send('stale')
  }

  const expected =
    'v1=' +
    crypto
      .createHmac('sha256', process.env.HOOKDROP_SECRET)
      .update(timestamp + '.')
      .update(req.body)
      .digest('hex')

  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send('bad signature')
  }

  res.sendStatus(200)
})
```

The `v1=` prefix exists so the scheme can change without breaking receivers that pin it.

Also sent, and not covered by the signature: `X-Hookdrop-Event-Id` and `X-Hookdrop-Attempt`.

**Delivery is at-least-once. Build your handler to be idempotent on `X-Hookdrop-Event-Id`.**
This is a property of delivering over a network, not a limitation of the queue: a `2xx` your
server sends and we never receive is indistinguishable from a request that never arrived, so
the only safe action is to try again. A worker killed after your server responded but before
the result was recorded produces the same outcome. Both cases send you a second copy of a
request you have already processed, carrying the same event id and a higher attempt number.

No queue technology changes this, and the pg-boss migration did not claim to: pg-boss makes
the *job* durable and its state transitions transactional, which is a guarantee about our
database, not about the request that leaves it.

### Secret handling

`Destination.secret` is `select: false`, so it is not loaded unless a query explicitly asks
for it. Exactly one query does: the delivery processor's, which needs the key to sign. No API
response returns it — the list, create and endpoint-detail endpoints all leaked it before
(H-11), which is why the column now has to opt in rather than opt out.

---

## Outbound delivery safety

### SSRF guard

`assertPublicUrl()` (`apps/worker/src/services/url-guard.ts`, mirrored in `apps/api`) runs
immediately before each connection and returns **one pinned IP address** that the request is
sent to. It rejects:

- any scheme other than `http:`/`https:`, and any URL carrying credentials;
- IPv4 literals in loopback, RFC1918, CGNAT, link-local (including `169.254.169.254`),
  multicast, reserved, benchmarking and TEST-NET ranges;
- IPv6 loopback, unique-local, link-local, multicast, discard, documentation, and the NAT64 and
  6to4 ranges that can encode a private IPv4 address;
- IPv4-mapped IPv6 forms of all of the above, in both dotted and hex notation
  (`::ffff:127.0.0.1`, `::ffff:7f00:1`);
- hostnames that resolve to *any* blocked address — every answer must be public, not just the
  first;
- `localhost`, `*.localhost`, `metadata`, `metadata.google.internal`, `instance-data`.

**Pinning is the part that closes DNS rebinding**, and it is why the guard returns an address
rather than a boolean. Validating a hostname and then handing the *hostname* to an HTTP client
leaves a second, unchecked resolution between the check and the socket: a name with a
zero-second TTL can answer public for the guard and private for the connection. The processor
connects to the resolved address; the hostname survives only in the `Host` header and in TLS
SNI, so certificate validation still happens against the real hostname and there is no second
lookup to poison.

A synchronous, DNS-free subset of the same checks runs inside the Zod schema at write time, so
an obviously-wrong destination is rejected with a clear message instead of being accepted and
failing every delivery afterwards. That is the honest boundary: Zod refinements cannot await a
resolution, so the write-time check is a convenience and the delivery-time check is the
control.

### Redirects

`maxRedirects` is 0. Up to three hops are followed manually, and **the guard re-runs on every
hop** — a destination that passes validation and then `302`s to `http://169.254.169.254/` is
precisely the case a single up-front check misses. A missing `Location`, or a fourth hop, is a
permanent failure.

### Status semantics and retries

Only `2xx` is a delivery. `validateStatus: (status) => status < 500` previously recorded every
`4xx` as delivered, so a destination answering `401` to every event looked perfectly healthy
(H-08).

| Outcome | Recorded as | Retried |
| --- | --- | --- |
| `2xx` | `delivered` | — |
| `5xx`, `408`, `423`, `425`, `429`, transport error | `retrying`, then `dead_letter` after 4 attempts | Yes — the processor asks pg-boss for another run |
| Other `4xx` | `failed` | No — it will never succeed |
| Blocked by the SSRF guard | `failed` | No. Retrying would turn one stored URL into four probes of internal address space |

Attempts are counted **per destination**, on the delivery row, and the database is the only
authority on how many remain. The queue's own `retryLimit` is a deliberately generous backstop
(10) whose purpose is to stop a job that keeps failing for a reason no delivery row records —
the database being unreachable, say — rather than to bound customer-visible retries. When that
backstop is what finally stops a job, the processor writes `dead_letter` to the delivery rows
itself and logs the classification `queue-budget-exhausted`, so a row is never left
non-terminal with no job behind it.

Under BullMQ these were two independent counters for one thing, and they could disagree:
`job.attemptsMade` covered every destination on the endpoint at once, so with one flaky and one
healthy destination the flaky one's retries were counted against a number the healthy one had
also incremented, and a destination added mid-retry inherited only whatever job attempts were
left.

Event status is decided once, after every destination has been handled. Bounds: 10-second
timeout, 256 KB response ceiling, and only the first 1000 characters of a response body are
stored — the column is for debugging, not archival.

---

## Inbound payment webhooks

Verified against **raw bytes**. The raw body parser is mounted app-level ahead of the JSON
parser, because a parsed-and-re-serialised body cannot reproduce a provider's MAC.

| Provider | Mechanism |
| --- | --- |
| Paystack | HMAC-SHA512 of the raw body with the secret key, compared to `x-paystack-signature` |
| Flutterwave | Shared secret compared to the `verif-hash` header. Flutterwave does not sign payloads; treating this as an HMAC is a common and incorrect reading (H-05) |
| Stripe | `constructEvent` over the Buffer with `STRIPE_WEBHOOK_SECRET` |

All comparisons go through a digest-then-`timingSafeEqual` helper that is length-safe and
rejects empty or absent signatures rather than comparing against `undefined` (H-39). A missing
verification secret means every callback from that provider is **rejected**, never trusted.

Entitlement does not come from the callback. `initializePayment` writes a ledger row carrying
the user, plan, expected amount and currency; the webhook resolves *that* row and compares
against it, so `metadata.plan` is never authoritative. Replay is prevented by a real `UNIQUE`
constraint on `provider_reference` in the database — not by an entity decorator, which with
`synchronize: false` is documentation rather than DDL, and was the reason replay detection was
inert (H-06, H-37).

---

## Tenant isolation

Every handler that takes an id scopes its query by `user_id` in the same statement, rather than
loading the row and comparing afterwards. Nested resources are checked at each level: an event
is reachable only through an endpoint the caller owns, a delivery only through such an event.

A resource owned by another tenant is indistinguishable from one that does not exist — both
answer `404`. Route parameters are validated as UUIDs before reaching Postgres, so a malformed
id is a `400` rather than a driver error carrying SQL.

Socket.IO connections authenticate during the handshake and must prove endpoint ownership to
join a room; anonymous sockets are confined to the public demo room. A handshake carrying a
malformed token is rejected — `verifyAccessToken` throws rather than returning null, and an
unguarded call meant one bad token took the process down (H-13).

---

## Rate limiting

Every limiter in both services keeps its state in Redis, via `rate-limit-redis`, so a limit
means the same number whatever the replica count. A per-process counter would multiply the
published rate by the number of instances, which is the failure mode most easily mistaken for
a working limiter.

### The ingest limiter is plan-aware

The ceiling comes from `plan.ingest_per_minute`, resolved once per request by
`resolveEndpoint` — which loads the endpoint, its owner and the owner's effective plan before
the limiter runs, so the plan-aware limit costs no extra query (S-3). Three things it fixes:

| Before | Now |
| --- | --- |
| `max: 60` for every account, so a Team subscriber paying for 500 000 events a month was held to a free account's rate | The plan's own `ingest_per_minute` |
| Every 429 read `60 requests per minute allowed on free tier`, including to paying customers | The 429 names the caller's own resolved limit, and deliberately **not** their plan id — the ingest URL's only credential is the token in it, so anyone who has seen a capture URL could otherwise read the account's tier out of a 429 |
| The marketing demo shared one bucket, keyed `rate:<token>`, so one visitor holding the demo button exhausted it for everybody | Demo traffic is keyed per client address, normalised to the IPv6 /64 so one allocation cannot mint unlimited keys |

Buckets are keyed per **account**, not per endpoint: the allowance is a property of the plan, so
the bucket has to be the thing the plan applies to, and `endpoints: null` on pro and team would
otherwise have made the effective limit unbounded for the tiers with the most capacity to cause
damage. One noisy endpoint can consume its account's allowance — accepted, and cheaper than a
limit that does not mean what the plan says.

No key contains a capture token any more. `rate:<token>` put a live credential into a Redis key
name, where it appeared in `KEYS`/`SCAN` output and any keyspace dump; keys now derive from the
account id, which is not a credential and survives a token rotation without handing the account
a fresh bucket.

### Fail-open and fail-closed are chosen per limiter

`passOnStoreError` is set deliberately on each one, and the two directions are both right:

| Limiter | On a Redis error | Why |
| --- | --- | --- |
| `login`, `register`, `refresh` | **Fail closed** (429) | The limiter *is* the brute-force control on these routes |
| `ai` | **Fail closed** | A spend control; a paid model must not go unmetered |
| `replay` | **Fail closed** | Each request resets delivery rows and enqueues a job |
| `public`, `api` (general) | Fail open | Fairness guards, not security controls |
| `ingest` | Fail open | See below |

Ingest fails open because rejecting a captured webhook when the *rate limiter's* cache is
unavailable trades a bounded, temporary loss of rate limiting for an unbounded, permanent loss
of customer data — from a service whose whole purpose is not losing them, with a healthy
database, while the provider retries and eventually disables the endpoint. The account-level
bound survives regardless: the metered ceiling is the monthly quota, and `quota.service.ts`
falls back to counting in Postgres when Redis is down.

### One behaviour change worth knowing about

`maxRetriesPerRequest` on the Redis connections was `null` — retry a command for ever — because
BullMQ requires that on the connections it blocks on, and the queue shared these connections.
Nothing blocks on Redis any more, so it is now `3`.

That is strictly better but it is a change: during a Redis outage, commands used to hang
indefinitely, holding the request, its socket and its database connection open until the client
gave up. They now fail in a few seconds. The `passOnStoreError` decisions above are what
determine what each route does with that error, and they had to be made explicitly *because* the
timing changed — under `null` the question never arose, because nothing ever returned an error
to answer it with. `enableOfflineQueue` stays at its default, so a reconnect measured in
milliseconds still queues rather than errors; the bound applies only once the connection is
genuinely gone.

---

## Event retention

Each plan advertises a retention window (`retention_hours`: 24 / 168 / 720 / 2160 hours for
free / starter / pro / team). Until the retention scheduler existed, **nothing read that
number** — the window was published on the pricing page, promised in the welcome email, and
enforced nowhere, so every event ever received was still stored in full.

The scheduler runs hourly in `apps/worker` and deletes events past their owner's window, in
batches, with `FOR UPDATE … SKIP LOCKED` so it never blocks ingestion.

Four properties worth knowing before you enable it:

1. **It keys off the stored `plan` column, not the computed effective plan.** Deletion is
   irreversible, and the subscription scheduler is what materialises a downgrade. Sweeping on
   the computed value would mean an expiry at 02:00 destroys a paying customer's history at
   02:25, before any human could notice the card had failed.
2. **One run has a bounded blast radius**: `RETENTION_BATCH_SIZE × RETENTION_MAX_BATCHES_PER_RUN`
   events per plan, 100,000 by default. A run that hits the cap logs that it was truncated
   rather than finishing silently, so there are hours to react.
3. **Unrecognised plan values are never swept**, only logged. Keeping data that should have
   been deleted is a storage bill; deleting data on a guess is not recoverable.
4. **`RETENTION_ENABLED=false` stops it** without a code change and a redeploy. It is the only
   scheduled job that destroys customer data, which is why it has an off switch at all. When
   disabled it says so loudly at boot, so nobody assumes it is running.

**The first run after enabling deletes everything already past its window** — for free-plan
accounts, every event older than 24 hours. That is the advertised behaviour and it is
irreversible. Take a backup first, and consider lowering the batch settings so the initial
sweep takes hours rather than minutes.

---

## Queues

The queue is **pg-boss** in the `pgboss` schema of the same PostgreSQL database that holds the
application data. There is no Redis in the queue path, and `apps/worker` holds no Redis
connection at all.

### Why Postgres and not Redis

Because the enqueue can then be part of the transaction that accepts the event. Under BullMQ
the ingest path was necessarily:

    INSERT event → COMMIT → queue.add()

and a crash, a SIGTERM or a Redis blip in the gap left a committed event with no delivery work
behind it. Nothing detected that: the event was visible in the dashboard as `received` and
stayed there, so the failure looked like a slow delivery rather than a lost one, and no retry
could recover it because retries are a property of a job that was never created.

The job is a row in `pgboss.job` now, inserted over the connection the event was written on, so
there is no gap to lose it in. If the transaction commits there is durable delivery work; if it
rolls back there is no orphan job. That is also why this repository has no outbox table and no
sweeper — an outbox exists to close exactly this window, and the window does not exist.

It follows that a pg-boss *process* being down cannot lose work either. The job is already
committed; it sits in the table until a worker returns for it. What a producer does require is
that the schema and the queues exist, which is why the producers refuse to create them — see
Ownership below.

**This does not make delivery exactly-once.** The queue is at-least-once by design and the
outbound HTTP request cannot be otherwise; see the note under
[Verifying deliveries](#verifying-deliveries).

### Queues and their registered settings

Five queues, registered by the worker on every boot from `apps/worker/src/queue/contract.ts`.
`createQueue` is idempotent, so editing the contract and redeploying the worker is how these
values change:

| Queue | Policy | Retry limit | Retry delay | Expire |
| --- | --- | --- | --- | --- |
| `delivery` | `standard` | 10 (backstop; see [retries](#status-semantics-and-retries)) | 5 s, exponential, capped at 300 s | 900 s |
| `email` | `standard` | 3 | 60 s, exponential, capped at 3600 s | 120 s |
| `retention` | `exclusive` | 0 | — | 1800 s |
| `subscription-expiry` | `exclusive` | 0 | — | 600 s |
| `demo-cleanup` | `exclusive` | 0 | — | 300 s |

`expire` replaces BullMQ's `stalledInterval`/`maxStalledCount`: a job held `active` longer than
its window returns to the queue, which is how a worker killed mid-delivery is recovered.

`exclusive` allows one job queued *or* active per queue. That is the property `node-cron` could
not provide — `cron.schedule` ran in every replica, so every worker fired its own retention
sweep on the same tick — and it means a sweep that overruns its interval causes the next tick to
be dropped rather than building a backlog. `retryLimit: 0` preserves the schedulers' behaviour:
a failed run waits for the next tick rather than retrying inside the interval.

The three cron expressions live in `pgboss.schedule`, registered cluster-wide from the database
with an explicit timezone (`SCHEDULER_TIMEZONE`). Query that table to see what is actually
scheduled; under `node-cron` the only way to answer that was to read the source.

### Job row retention

`retention_seconds` is pg-boss's default of 14 days: a completed or failed job row is removed
that long after it was created, by the maintenance loop. Nothing removed completed or failed
jobs before this was configured under BullMQ either, so Redis grew without limit (H-38 era).
The difference is where the growth now lands — a partitioned table in the database you already
back up and monitor, rather than an in-memory store where it competes with the rate limiters.

Only the worker runs that loop (`supervise: true`). Both producers set `supervise: false`, so
adding API replicas does not multiply maintenance work.

### Ownership

| | `worker` | `api`, `ingestion` |
| --- | --- | --- |
| Consumes jobs | Yes — the only consumer | No |
| Installs / migrates the queue schema | Yes | No: `migrate: false`, `createSchema: false` |
| Registers queues | Yes | No |
| Maintenance loop | Yes | No: `supervise: false` |
| Cron loop | Yes | No: `schedule: false` |
| Pool size | `PGBOSS_POOL_MAX` (default 4) | 2 |

A producer started against a database where the schema or the queues are missing fails
immediately and says so, rather than quietly creating tables nobody agreed to. **So the worker
must be deployed once before the producers start.** On a fresh database that is the deployment
order; on an existing one the worker's next boot does it.

pg-boss owns the DDL for its own tables entirely — it installs and migrates them, and
`npx pg-boss create|migrate|doctor` manages them from the command line. Nothing in this
repository hand-writes that schema, `node-pg-migrate` keeps owning `public`, and `synchronize`
stays `false` in all three services, so TypeORM never sees the `pgboss` tables. See
[Schema changes](#schema-changes).

### Concurrency bounds

Three of them, and they are independent:

| Bound | Value | What it limits |
| --- | --- | --- |
| `localConcurrency` | `DELIVERY_CONCURRENCY` (5), `EMAIL_CONCURRENCY` (2), sweeps 1 | Jobs in flight in one worker process |
| `groupConcurrency` | 1, on `delivery` | Jobs for **one event** running anywhere in the cluster |
| Sequential destinations | — | Requests in flight for one event: destinations are delivered one at a time inside the handler |

The group bound is the one worth understanding. Every delivery job carries
`group: { id: eventId }`, so two jobs for the same event — a redelivery after a crash, or a
replay published while the first is still in flight — cannot run concurrently on different
replicas. Without it, two workers could send the same event to the same destination at the same
moment, and the idempotency check on the delivery row would not help: both would read it as
non-terminal before either wrote.

Destinations stay sequential inside the handler. pg-boss makes parallelism easy and this is a
place not to take it: fanning out would multiply the request rate against a customer's
infrastructure, and the per-destination attempt accounting is simpler to reason about when one
request is in flight at a time.

### Draining the retired Redis queues

**One-time, for anyone upgrading across this migration.** BullMQ's keys are still in Redis
after the upgrade — `bull:delivery:*`, `bull:email:*`, and `bull:ai:*` from the earlier H-04
retirement. Nothing consumes them, nothing produces to them, and no code path can see them, so
they will sit there indefinitely occupying memory that the Socket.IO adapter and the rate
limiters need.

Jobs already in Redis are **not** touched by the code change: deleting a queue is destructive
and belongs to an operator, not to a module that runs on boot.

Before draining, check whether any `bull:delivery:*` job is still waiting. A job in there was
enqueued by the pre-migration code and will never be delivered by the new worker — it is not in
`pgboss.job`. If the counts are not zero, the events those jobs referenced are recoverable
through **Replay** in the dashboard, which is the supported way to re-create the work; obliterate
only after that.

```js
// drain-bull-queues.js — run once, with REDIS_URL pointing at the intended environment.
// Requires bullmq and ioredis, which this repository no longer depends on:
//   npm i --no-save bullmq ioredis
const { Queue } = require('bullmq')
const IORedis = require('ioredis')

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
  ...(process.env.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {}),
})

;(async () => {
  for (const name of ['delivery', 'email', 'ai']) {
    const queue = new Queue(name, { connection })

    // Look before you delete.
    console.log(name, await queue.getJobCounts())

    // Removes the queue's keys, including jobs. Irreversible.
    await queue.obliterate({ force: true })

    await queue.close()
  }

  await connection.quit()
})()
```

Check the counts first and confirm they are what you expect. `obliterate` is irreversible, and
`force: true` proceeds even with active jobs. If every count is zero, there is nothing to do and
the script can be skipped entirely.

Redis itself is **not** retired. It still backs the Socket.IO adapter and the rate limiters —
see [Configuration and secrets](#configuration-and-secrets) — and `REDIS_URL` stays required for
`api` and `ingestion`.

---

## Logging discipline

Names, never values (H-48). Concretely:

- Configuration errors name the variable and the reason and never echo the value. Validation
  failures return field names and messages — a rejected password must not come back in an
  error body that ends up in a log or an error tracker.
- Database errors are logged as `error.message` only. A TypeORM `QueryFailedError` carries the
  failing SQL **and its bound parameters**, which on these paths include admin search terms and
  the hash of a live credential. Connection strings are redacted from the one place that can
  contain them.
- No credential, token, API key or webhook secret is logged at any level, including on the
  failure paths. The plaintext API key exists only in the response that creates it.

---

## Operational procedures

### Schema changes

`synchronize` is `false` in all three services. Every schema change is a `node-pg-migrate`
migration under `migrations/`, reviewable and reversible. **An entity decorator without a
migration behind it is documentation, not DDL** — that mistake is what made payment replay
detection inert, because the `UNIQUE` constraint its `.orIgnore()` depended on existed only as
a decorator (H-06, H-37).

Apply with `npm run migrate:up`. Every migration in this remediation has a working `down`;
verify a new one with `up` → `down` → `up` against a scratch database before it goes near a
real one.

Two schemas, two owners, and they do not overlap:

| Schema | Owned by | Managed how |
| --- | --- | --- |
| `public` | `node-pg-migrate` | Migrations under `migrations/`, applied by `npm run migrate:up` |
| `pgboss` | pg-boss | Installed and migrated by the worker on boot; `npx pg-boss create\|migrate\|doctor` from the command line |

The queue schema needs **no** migration in `migrations/` and must not be given one. pg-boss
versions its own schema and migrates forward when a newer library version starts against an
older installation, which a hand-written copy of its DDL would break. Upgrading `pg-boss` is
therefore a worker deployment, and it wants to be the first service redeployed.

Because `synchronize` is `false` everywhere, TypeORM never sees the `pgboss` tables — there is
no entity for them and nothing would generate DDL against them even if it did. That is a
requirement rather than an accident: `synchronize: true` in any service would let TypeORM decide
that tables it has no entities for should not exist.

### Deployment topology

The three Node services (`api`, `ingestion`, `worker`) run as long-lived processes. A persistent
queue worker and a Socket.IO server cannot run as serverless functions, so `vercel.json` covers
`apps/web` only and the rest belongs on a platform that runs containers (H-45). Set
`TRUST_PROXY_HOPS` to the number of proxies actually in front of each service.

Moving the queue to Postgres does not change that. The worker holds long-lived pg-boss workers
that poll, a maintenance loop and three cron schedules; it drains in-flight jobs on SIGTERM
within a bounded budget. None of that survives a function that is frozen between invocations.

Deploy the worker **before** the producers on a fresh database — it is the only service allowed
to install the queue schema, and `api` and `ingestion` refuse to start without it. See
[Ownership](#ownership).

### After an incident

1. Rotate the credential that leaked — see [Rotation semantics](#rotation-semantics) for what
   each rotation invalidates.
2. `POST /api/auth/logout-all` per affected account, or revoke the specific API key.
3. If inbound event headers may hold third-party credentials, treat them as exposed: they have
   been readable through the events API, the dashboard, and the AI prompts for as long as they
   have been stored. Removing them from storage does not un-expose them; their owner must
   rotate them.
4. Removing a secret from source does not remove it from git history.

---

## Known gaps

Recorded here rather than described above as though they were finished.

- **Unknown-token floods still reach the database.** An unknown capture token costs one indexed
  query and is answered `404` without touching Redis. Nothing bounds how many of those arrive
  per second, because the limiter runs *after* resolution and its key derives from the account
  id — which is only knowable from the query the flood is causing. The pg-boss migration
  removed the amplification (`rate:<token>` minted a Redis key per distinct token, so a flood of
  random tokens created unbounded keys; it now creates none) but not the flood. The obvious fix,
  an IP-keyed limiter mounted before `resolveEndpoint`, is not in place because webhook providers
  send from small address pools: an IP bucket on the ingest path throttles Stripe and GitHub
  before it throttles an attacker. Bounding it properly means a check cheaper than the endpoint
  query — a token-shape reject, or a bloom filter of live tokens — and neither is built.
- **The demo's per-minute volume is bounded only by the monthly quota and the hourly cleanup.**
  Keying demo traffic per client address fixed the shared bucket, and the cost is that total
  demo volume is no longer bounded per minute: a thousand visitors get a thousand buckets, and
  one client with a /48 can mint 65 536 of them. Two things still bound it, both outside the
  limiter — the demo account's monthly event quota, enforced against Postgres in the handler,
  and the worker's hourly `demo-cleanup`. So the worst case is the demo's monthly allowance
  consumed in a short window, with the rows sitting in `events` until the next cleanup, rather
  than unbounded growth. Isolating a shared demo is worth that; the alternative is a public
  feature any single visitor can switch off for everyone.
- **Not verified against production.** Nothing in this remediation was run against production
  data or a payment dashboard. The production-verification checklist is part of the final
  audit report, not this document.
- **Retention has a downgrade cliff.** Sweeping on the stored `plan` column is the safe
  direction, but it means retention shortens the hour a downgrade is materialised, not the hour
  a subscription lapses. An account that drops from pro to free has its history trimmed from
  720 hours to 24 at the next sweep after the subscription scheduler writes the new plan.
- **Per-run cap can mask a backlog.** If a single run hits
  `RETENTION_BATCH_SIZE × RETENTION_MAX_BATCHES_PER_RUN` for a plan, the remainder waits for the
  next hour. The truncation is logged; nothing pages on it.
- **`url-guard.ts` is duplicated** between `apps/api` and `apps/worker`, deliberately, because
  npm workspaces cannot import across sibling apps without a shared package. Until that package
  exists, changes go in both files, and `diff` between them should report only the header
  comment.
