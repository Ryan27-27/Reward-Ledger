# Pointwise — a rupee wallet with rewards you can trust

Members keep money in a rupee wallet (like Paytm / Amazon Pay), pay and send money from it, earn reward points on every payment,
and **convert points back into wallet cash at 100 points = ₹3**, paid from a company-funded treasury. Everything lives in a
tamper-evident ledger.
Built as a real product: **Node.js + Express + PostgreSQL** backend, **React (Vite)** frontend.

It merges the three projects you supplied: the double-entry ledger and idempotency from `backend-ledger`,
the OTP / sessions / mailer flow from `yt-auth`, and the reward rules, tiers and audit ideas from `fullstack-ledger`
— rebuilt so the weaknesses of each are closed (see *What was fixed* below).

## Run it

```bash
# Everything (Postgres, API, client, Mailpit email inbox)
docker compose up --build
#  web  → http://localhost:8080      emails → http://localhost:8025 (OTP codes, credit/debit notices)
docker compose exec api node scripts/create-admin.js you@example.com "Your Name"

# Or locally
npm run install:all                                      # from the repo root
cd server && cp .env.example .env                        # then:
npm run migrate && npm run seed && npm run dev           # API on :4000
cd client && npm install && npm run dev                  # UI on :5173 (proxies /api)
npm test                                                 # in server/ — needs Postgres (see DATABASE_URL)
```

Seed accounts (password `Pointwise#2026`): `demo@pointwise.dev` (member), `admin@pointwise.dev` + `admin2@pointwise.dev`
(two admins, needed for maker-checker), `auditor@pointwise.dev` (read-only).

## How the money works

```
 Member adds ₹500 ──► FUNDS_IN ─────────► member rupee wallet           (gateway webhook in production)
 Member pays ₹1,000 from wallet ─► MERCHANTS      + earns 80 points   (one atomic transaction)
 Member converts 1,000 points ──► TREASURY ─────► member rupee wallet   (1,000 pts × 3 paise = ₹30)
 Company funds the pool ───────► FUNDS_IN ─────► TREASURY               (needs a 2nd admin's approval)
```

* **Two wallets per member:** points and rupees (starts at ₹0). Same ledger engine for both; they never share a journal.
* **The treasury is the root account.** It holds the reward pool, is balance-checked on every payout (`CHECK balance >= 0`) and is locked
  during conversions, so it can't be overdrawn even under heavy concurrency (tested: ₹81 in the pool, 5 simultaneous ₹27 conversions → exactly 3 pay out, the other 2 roll back with the members' points untouched).
* **Conversion is one transaction:** debit points → debit treasury → credit wallet. Any failure rolls all of it back.
* **Economics, so you can price it:** 100 points = ₹3 means 1 point = ₹0.03. At the base shopping rate (8 points per ₹100) a ₹100 payment earns ₹0.24 of cash value
  (0.24%), rising to 0.48% at Platinum. The admin *Treasury* tab shows the pool, the cash value of all outstanding points, and a coverage ratio with a low-funds warning.
* **Limits (all configurable, `server/.env.example`):** ₹50,000 max wallet balance, ₹25,000 per top-up/transfer, ₹50,000 daily outbound, 50,000 points/day convertible,
  emailed one-time code for transfers ≥ ₹2,000 and conversions ≥ 1,000 points (bound to the exact amount and recipient).
* **Not included on purpose:** withdrawing wallet money to a bank account. That is where KYC and prepaid-instrument rules bite hardest.

## Payment addresses (VPAs) and why points can't be farmed

Every member gets a unique address at registration — `riya.demo@pointwise` (domain via `VPA_DOMAIN`). Anyone can pay it from **Wallet → Send money**;
existing members get one automatically on the next start. Names are masked when you look an address up, lookups are rate-limited, and suspended or unverified members can't be paid.

**The rule that kills the "two users pay each other in a loop" exploit: reward points are only earned when money leaves the member network**
(a payment to a merchant or biller). Member-to-member transfers — including every payment to a payment address — earn **nothing**, so a loop between two accounts is just
money moving back and forth. This is enforced three ways, not just by convention:

1. **Code:** `transfer()` never touches the reward engine; the only code that creates `EARN` journals is `createPayment`.
2. **Database:** `CHECK (kind <> 'EARN' OR COALESCE(reference_type,'') = 'payment')` — even a bug or hand-written SQL can't mint points outside a payment.
3. **Tests:** 60 transfers back and forth (plus 20 simultaneous opposing ones) leave both members at 0 points, 0 payment rows and money exactly conserved.

Other "free points" loops that were checked: refund-and-repeat (rewards are clawed back, and the bonus can't be re-claimed), points→cash→spend→points (spending ₹10,000 returns well under 1% in reward value, so the cycle always loses money),
and **sign-up bonus farming** — the 50-point first-payment bonus (₹1.50 of cash value) used to be paid on a ₹1 payment; it now needs a payment of at least ₹100 (`FIRST_PAYMENT_BONUS_MIN_PAISE`), once per member, and the referrer's bonus follows the same rule.

*Still open (needs product decisions, not just code):* one person making many accounts. In production that costs real money (every payment must come through the gateway), but for a public launch add
phone/KYC verification, device and payment-method de-duplication, and hold the referral bonus until the referred member's payment settles.

## Features

**Members** — rupee wallet (add money, send to friends, pay from it) · points→cash conversion · email-verified signup · login with lockout · rotating sessions · live balance and tier progress ·
reward preview before paying · payments with server-computed rewards · full statement with running balance, CSV export ·
"ledger verified" seal · catalog redemption with emailed-OTP step-up for large amounts · referral bonus ·
points expiry (12 months, soonest-expiring spent first) · expiry warnings · session management ·
**an in-app notification and an email for every single credit and debit**, pushed live over SSE.

**Admins** — treasury console (pool balance, liability, coverage, funding requests) · dashboard & circulation stats · member search · freeze/unfreeze, suspend/reinstate ·
**maker-checker** grants, reversals and refunds (a *different* admin must approve) · catalog management ·
immutable audit log · one-click full-ledger verification · read-only `AUDITOR` role.

**Platform** — signed payment-gateway webhook (HMAC + timestamp, idempotent) · transactional outbox with retries/backoff ·
rate limiting · kill-switch for simulated money (`ALLOW_SIMULATED_PAYMENTS`, off in production) · request IDs · structured logs · Prometheus `/metrics` · health/readiness probes · graceful shutdown · CI.

## The ledger (the part that has to be right)

| Guarantee | How it is enforced |
|---|---|
| **Immutable history** | DB triggers reject `UPDATE`/`DELETE`/`TRUNCATE` on `journals`, `ledger_entries`, `admin_audit_log`. Mistakes are fixed with a *reversing journal*, never an edit. |
| **Tamper-evident** | Every wallet entry stores `hash = sha256(prev_hash, seq, amount, …)`. `verifyWallet` replays the chain; editing any row (even as superuser) is detected. |
| **Double entry** | Every journal is wallet ↔ system account; a deferred constraint trigger makes an unbalanced journal impossible to commit. |
| **No overdraft / double spend** | Wallet row is locked (`FOR UPDATE`) before the balance is read, plus `CHECK (balance >= 0)`. Tested: 5 parallel redemptions of a 600-pt item on a 1000-pt wallet → exactly one succeeds. |
| **Exactly-once effects** | `Idempotency-Key` on every money-moving POST, unique per wallet; same key + different body → `409`. Tested with 10 simultaneous identical requests. |
| **Integer money** | Points and paise are `bigint`/integers; multipliers are basis points. No floats. |
| **Notified or not committed** | Credit/debit emails are written to the *outbox in the same transaction*; SMTP being down can't lose or block a ledger write. |

## Who can touch a member's points

* **Money and points leave a member's wallet only when the member acts** (redeem, convert, pay, send — each request has no `accountId`; the wallet is always the authenticated member's), when points expire,
  or via a **reversal that one admin requested and a different admin approved** (`CHECK (decided_by <> requested_by)` in the DB).
* **There is no admin endpoint that debits, redeems, withdraws or edits any balance — member or treasury.** Admins can only *request* grants, reversals, refunds and treasury funding; a second admin approves. Tested.
* Grants are capped, need a written reason, need a second admin, are audit-logged, and **email the member**.
* Reversals only work on manual grants, only once, and are refused if the points were already spent.
* Payment rewards are only clawed back by a refund (gateway webhook or approved request).
* Admin/auditor roles can't be obtained via the API — only by CLI/SQL.

## Auth model

scrypt password hashing · 15-min JWT access token held **in memory** · refresh token in an `HttpOnly; SameSite=Strict` cookie,
stored hashed, **rotated on every use, reuse of an old token kills the session** (with a 10 s race window for two tabs) ·
every request also checks the session/user row, so logout, "sign out everywhere", suspension and password reset take effect
**immediately** · OTPs are HMAC-hashed, 10-min TTL, 5 attempts, rate-limited · login lockout after 5 failures · constant-time
unknown-user path · origin check on mutating requests · Helmet, strict validation (zod, unknown fields rejected).

## API (all under `/api`, errors are `{ error: { code, message, requestId } }`)

```
auth      POST register | verify-email | resend-verification | login | refresh | logout | logout-all
               forgot-password | reset-password | change-password      GET me | sessions   DELETE sessions/:id
wallet    GET  wallet | wallet/statement?before&limit | wallet/statement.csv | wallet/audit
payments  POST payments/preview | payments (Idempotency-Key)           GET payments | rewards/rules
rewards   GET  catalog | redemptions        POST redemptions/challenge | redemptions (Idempotency-Key, otp?)
notify    GET  notifications | notifications/stream (SSE)             POST notifications/read-all | :id/read
money     GET  money/wallet | money/vpa | money/quote | money/recipient?to=<address or email>
          POST money/topup | money/challenge | money/transfer {to: address or email} | money/convert   (Idempotency-Key; step-up otp on large amounts)
webhook   POST webhooks/payments  (payment.succeeded | payment.refunded | wallet.topup.succeeded)   X-Pointwise-Signature: t=<unix>,v1=hmac_sha256("<t>.<raw body>")
admin     GET  stats | users | users/:id | approvals | audit-log | ledger/verify | catalog | wallets/:id/verify
          GET  treasury      POST accounts/:id/freeze|unfreeze (freezes both wallets) | users/:id/suspend|reinstate | approvals | approvals/:id/approve|reject | catalog
          PATCH catalog/:id
```

## What was fixed relative to the uploaded outlines

* `backend-ledger`: any user could transfer **from any account** (no ownership check); the source account was looked up by id only, and the balance was checked *outside* the DB
  transaction (double-spend race); a 15-second `sleep` held a transaction open; floats for money; failed transactions weren't aborted.
* `yt-auth`: refresh tokens rotate, but a replayed old token is just rejected (a thief holding the newest one keeps working, nothing is revoked); access tokens carry no session id, so logout / sign-out-everywhere can't cut them off before the 15-minute expiry.
* `fullstack-ledger`: admin could debit members' points; ledger rows were mutable; no notification on movement.

## Layout

```
pointwise/
├─ client/   React + Vite frontend
├─ server/   Node + Express + PostgreSQL API
├─ docker-compose.yml · README.md · .github/workflows/ci.yml
```

```
server/  migrations/001_init.sql   schema + triggers (start here)      src/services/ledger.js   THE write path
         src/services/*            auth, payments, redemptions, admin, expiry, outbox, realtime
         test/                     71 tests against real Postgres (concurrency, treasury solvency, tamper, governance, auth, wallet)
client/  src/pages/*               Dashboard, Pay, Activity, Rewards, Security, Admin
```

## Before real users (honest checklist)

* **Compliance:** points that can be converted to cash may be regulated (e.g. prepaid-instrument rules in India, money-transmitter rules elsewhere). Take legal advice before launch; this codebase gives you the controls, not the licence.
* **Payments:** plug a real gateway (Razorpay/Stripe) into `POST /webhooks/payments` (`payment.succeeded`, `payment.refunded`, `wallet.topup.succeeded`). Keep `ALLOW_SIMULATED_PAYMENTS=false` in production — the demo buttons create money and points from nothing.
* **Wallet licensing:** holding customer money in a wallet is regulated (in India: RBI prepaid payment instrument rules, KYC limits; elsewhere: e-money / money-transmitter rules). The wallet limits here are controls, not compliance. Get legal advice before holding real funds.
* **Known limitation:** refunding a wallet payment also claws back its reward points; if the member already spent those points the refund is refused until an admin resolves it.
* **Secrets/infra:** set strong `JWT_SECRET`/`OTP_SECRET`/`WEBHOOK_SECRET`, serve over HTTPS (`COOKIE_SECURE=true`), run Postgres with backups/PITR, and use an app DB role without `ALTER`/`TRUNCATE` rights.
* **Scale-out:** rate limiter is per-instance (swap in a Redis store); SSE works across instances through Postgres `LISTEN/NOTIFY`; the outbox and expiry workers are safe to run on many instances.
* **Roadmap:** Redis cache, TOTP/WebAuthn 2FA for admins, partner-merchant earn rules, push/SMS channels, i18n, OpenAPI docs, scheduled hash-chain anchoring to external storage.
