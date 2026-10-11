# Pointwise

### A secure wallet and rewards platform built around a verifiable ledger

Pointwise is a full-stack demo of a rupee wallet and rewards ecosystem.
Members can manage wallet balances, send money to other members, make
simulated payments, earn and redeem points, and convert eligible points
into wallet cash. Administrative workflows are designed around
separation of duties, auditability, and controlled changes.

The central engineering goal is **financial correctness under retries,
failures, and concurrent requests**---not simply storing a balance in a
database.

> **Important:** Pointwise is a portfolio/demo project, not a licensed
> financial service. Local demo payments can create simulated funds. Do
> not connect it to real customer funds or deploy it as a live wallet
> without a real payment provider, appropriate security controls, and
> legal/compliance review.

## Highlights

-   **Double-entry ledger:** wallet movements are recorded as balanced
    journals rather than arbitrary balance edits.
-   **Concurrency-safe money movement:** database transactions, row
    locking, and non-negative balance constraints protect against
    overspending.
-   **Idempotent writes:** money-moving requests accept an
    `Idempotency-Key` to prevent duplicate effects when clients retry.
-   **Tamper-evident history:** wallet entries are hash-chained and can
    be replayed to verify the recorded balance.
-   **Points and rupees kept separate:** rewards use a distinct points
    wallet and journal from the rupee wallet.
-   **Controlled points-to-cash conversion:** conversions debit points
    and the company-funded treasury while crediting the member's wallet
    in one transaction.
-   **Anti-farming rules:** member-to-member transfers do not earn
    points; rewards are tied to eligible payments.
-   **Secure account flows:** email verification, password hashing,
    short-lived JWT access tokens, rotating refresh sessions, OTP
    step-up checks, login lockout, and session revocation.
-   **Two-person administrative approvals:** sensitive grants,
    reversals, refunds, and treasury funding require a different
    administrator to approve.
-   **Reliable notifications:** email events are written to a
    transactional outbox and retried by a worker.
-   **Operational visibility:** structured logs, request IDs,
    health/readiness endpoints, and Prometheus metrics.

## Tech stack

  Layer                           Technologies
  ------------------------------- ----------------------------------------------------------
  Frontend                        React, Vite, JavaScript
  API                             Node.js, Express
  Database                        PostgreSQL
  Authentication and validation   JWT, HttpOnly cookies, `scrypt`, Zod
  Email                           Nodemailer / SMTP; Mailpit for local development
  Operations                      Docker Compose, structured logging, Prometheus metrics
  Testing                         Node.js test runner, PostgreSQL-backed integration tests

## Architecture

``` mermaid
flowchart TD
    U[Member or Admin] --> FE[React + Vite client]
    FE --> API[Express REST API]
    API --> AUTH[Authentication and authorization]
    API --> SVC[Wallet, payments, rewards and admin services]
    AUTH --> DB[(PostgreSQL)]
    SVC --> DB
    SVC --> OUTBOX[Transactional email outbox]
    OUTBOX --> SMTP[SMTP / Mailpit]
    API --> METRICS[Health endpoints and Prometheus metrics]
    GW[Payment provider / simulated demo flow] --> WH[Signed webhook endpoint]
    WH --> SVC
```

The database is the source of truth for ledger entries and balances.
Money-moving operations are performed transactionally so related journal
entries, balance updates, idempotency records, and outbox events succeed
or roll back together.

## Run locally with Docker

**Prerequisites:** Docker Desktop (or Docker Engine) and Docker Compose.

1.  Clone the repository and open its root directory.

2.  Start the application:

    ``` bash
    docker compose up --build
    ```

3.  Open the local services:

      Service             URL
      ------------------- ---------------------------------
      Pointwise web app   <http://localhost:8080>
      API health check    <http://localhost:4000/healthz>
      Mailpit inbox       <http://localhost:8025>

    Mailpit captures local emails, including verification codes, OTPs,
    and wallet notifications.

4.  Create an administrator account:

    ``` bash
    docker compose exec api node scripts/create-admin.js you@example.com "Your Name"
    ```

    Follow the CLI prompts/instructions to create the account. Sensitive
    admin roles are not self-assigned through the public registration
    API.

To stop the services:

``` bash
docker compose down
```

To stop the services and remove the local database volume as well:

``` bash
docker compose down -v
```

> `docker compose down -v` deletes the local demo database. Use it only
> when you want to reset your local data.

### Seeded demo accounts

The seed script creates local demo users for exploring member,
administrator, and auditor flows. In the seeded environment, the demo
password is `Pointwise#2026`.

  Role                   Account
  ---------------------- -------------------------
  Member                 `demo@pointwise.dev`
  Administrator          `admin@pointwise.dev`
  Second administrator   `admin2@pointwise.dev`
  Read-only auditor      `auditor@pointwise.dev`

These credentials are for a disposable local environment only. Do not
reuse them in a public deployment. If the seed script's accounts are
unavailable in your environment, run the seed command described below.

## Run without Docker

**Prerequisites:** Node.js 20 or later, npm, and a running PostgreSQL
instance.

1.  Install dependencies from the repository root:

    ``` bash
    npm run install:all
    ```

2.  Create the server environment file:

    ``` bash
    cp server/.env.example server/.env
    ```

    On Windows PowerShell, use:

    ``` powershell
    Copy-Item server/.env.example server/.env
    ```

3.  Set `DATABASE_URL` and generate unique secrets for `JWT_SECRET`,
    `OTP_SECRET`, and `WEBHOOK_SECRET`. Each production secret must be
    at least 32 characters long. Configure `SMTP_URL` if you want email
    delivery; for local testing, Mailpit is convenient.

4.  Apply migrations and seed demo data:

    ``` bash
    cd server
    npm run migrate
    npm run seed
    npm run dev
    ```

    The API runs on port `4000` by default.

5.  In a second terminal, start the frontend:

    ``` bash
    cd client
    npm install
    npm run dev
    ```

    Vite runs the UI on port `5173` and proxies `/api` requests to the
    local API.

## How the ledger works

### Double-entry accounting

Every journal represents a movement between a wallet and a system
account. A deferred database constraint checks that each journal
balances before commit. The ledger is append-only: corrections are
represented by reversal entries rather than silently editing historical
movements.

### Idempotency and concurrency

Money-moving endpoints accept an `Idempotency-Key`. Repeating a request
with the same key and payload should not post the movement twice;
reusing the key with a different payload is rejected. Wallet rows are
locked during critical balance changes, and database constraints provide
a final guard against negative balances.

### Points-to-cash conversion

The demo conversion rate is configurable. The default is **100 points =
₹3**. A conversion debits the member's points wallet and the treasury,
then credits the member's rupee wallet in the same database transaction.
If any part fails, the transaction rolls back.

### Reward anti-farming

Member-to-member transfers do not earn reward points. Eligible payment
events are the reward-earning path. The project also applies
minimum-payment and one-time rules to first-payment/referral bonuses and
includes refund clawback logic.

### Tamper-evident verification

Wallet entries include a hash derived from the previous entry and the
current entry data. The audit flow replays the ledger and compares the
computed balance with the stored balance. Hash chaining helps detect
changes to recorded history; it is not a substitute for independent
backups, restricted database privileges, or externally anchored audit
records.

## Security model

-   Passwords are hashed with `scrypt`.
-   Access JWTs are short-lived; refresh sessions use an `HttpOnly`
    cookie and rotate on use.
-   Reuse of a previously rotated refresh token triggers session
    revocation logic.
-   Email verification and time-limited, attempt-limited OTP challenges
    protect account and high-risk flows.
-   Mutating requests are subject to origin checks, request validation,
    and security headers.
-   Sensitive administrator actions use maker-checker approval: the
    requester cannot approve their own request.
-   Admin and auditor roles are provisioned through trusted operational
    tooling, not public self-registration.

These are application-level controls for a learning/demo project. They
do not by themselves establish regulatory compliance or make the
application production-ready.

## API overview

API routes are grouped under `/api`. Errors use a consistent shape:

``` json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable explanation",
    "requestId": "request-correlation-id"
  }
}
```

  -----------------------------------------------------------------------
  Area                                Representative operations
  ----------------------------------- -----------------------------------
  Authentication                      Register, verify email, login,
                                      refresh, logout, password reset,
                                      session management

  Wallet                              Balance, statement, CSV export,
                                      ledger audit

  Payments and rewards                Preview payment, make payment, view
                                      payment history and reward rules

  Redemptions                         Browse catalog, request OTP
                                      challenge, redeem rewards

  Money movement                      Top up (demo), transfer to a
                                      payment address, quote/convert
                                      points

  Notifications                       List notifications, mark as read,
                                      stream live updates

  Administration                      Member management,
                                      freezes/suspensions, catalog
                                      management, approvals, audit log,
                                      ledger verification, treasury
                                      overview

  Webhooks                            Process signed payment
                                      success/refund/top-up events
  -----------------------------------------------------------------------

For exact request and response schemas, inspect the route handlers under
`server/src/routes/` and the API implementation. Do not assume an
endpoint accepts fields beyond those validated by the application.

## Tests

Run the backend test suite from the repository root:

``` bash
npm test
```

The test suite uses Node's built-in test runner and exercises ledger,
API, wallet/money movement, payment-address, and reward-rule behavior.
The most valuable scenarios to explore are:

-   Concurrent requests against a wallet with insufficient funds.
-   Repeated idempotency keys and mismatched request payloads.
-   Treasury solvency when several conversions run at the same time.
-   Hash-chain and balance-replay verification.
-   Attempts to earn points from member-to-member transfers.
-   Approval separation between the administrator who requests an action
    and the one who approves it.

A test count or pass rate should only be published after running the
suite in the current revision and confirming the result.

## Repository structure

``` text
pointwise/
├── client/                    # React + Vite frontend
├── server/
│   ├── migrations/             # PostgreSQL schema, constraints and triggers
│   ├── scripts/                # Seed data and admin creation
│   ├── src/
│   │   ├── routes/              # HTTP routes
│   │   ├── services/            # Ledger, payments, rewards, auth, admin, outbox
│   │   ├── middleware/          # Authentication, validation, errors, rate limiting
│   │   ├── db.js
│   │   └── app.js
│   └── test/                   # Automated tests
├── .github/workflows/          # CI workflow
├── docker-compose.yml
└── README.md
```

## Production-readiness checklist

Pointwise is a demonstration system. Before any real-money use:

-   **Payments:** integrate a real provider and verify its webhook
    signatures and event lifecycle. Set
    `ALLOW_SIMULATED_PAYMENTS=false`; demo payment flows can create
    funds without a real settlement.
-   **Legal and compliance:** obtain appropriate legal advice before
    holding funds or offering points convertible to cash. Wallet,
    prepaid-instrument, KYC, and money-transmission obligations depend
    on jurisdiction and product design.
-   **Secrets and transport:** replace all demo secrets, use HTTPS, set
    secure cookie settings, and keep credentials out of source control.
-   **Database operations:** use least-privilege database roles,
    backups, point-in-time recovery, and tested restore procedures.
-   **Monitoring and resilience:** configure alerting, operational
    dashboards, SMTP delivery monitoring, and incident-response
    procedures.
-   **Security review:** perform independent application testing,
    dependency review, abuse testing, and a threat-model review before
    exposing the service publicly.

## Roadmap

-   Publish a live demo with clearly labeled simulated transactions.
-   Add screenshots and a short walkthrough of member and admin
    workflows.
-   Add load-test reports with reproducible hardware/configuration
    details.
-   Add a formal OpenAPI specification and external anchoring for ledger
    verification.
-   Evaluate production-grade multi-instance rate limiting and stronger
    administrator MFA.

------------------------------------------------------------------------

Built as a portfolio project to explore financial data integrity,
concurrency control, application security, and reliable backend
workflows.
