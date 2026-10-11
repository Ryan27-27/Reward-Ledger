-- Pointwise schema v1.
-- Design rule: money-like state is *append-only*. History is never edited; mistakes are
-- fixed with compensating journals. The database itself enforces this (triggers below),
-- so a bug, a rogue admin endpoint or manual SQL cannot silently rewrite history.

-- ───────────────────────── identity ─────────────────────────
CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,
  name              text NOT NULL,
  password_hash     text NOT NULL,
  role              text NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','ADMIN','AUDITOR')),
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  email_verified_at timestamptz,
  referral_code     text NOT NULL UNIQUE,
  referred_by       uuid REFERENCES users(id),
  failed_logins     int NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Rotating refresh tokens. Only SHA-256 hashes are stored. Presenting an already-rotated
-- token (outside a short race window) revokes the whole session = theft detection.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  rotated_at  timestamptz,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('VERIFY_EMAIL','RESET_PASSWORD','REDEEM')),
  code_hash   text NOT NULL,
  context     text,
  attempts    int NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otps_lookup_idx ON otps (user_id, purpose, created_at DESC);

-- ───────────────────────── ledger ─────────────────────────
-- WALLET accounts: one per user, row-locked on every posting, balance cached + hash-chained.
-- SYSTEM accounts: ISSUANCE / REDEMPTION / EXPIRY never locked (no global hot row);
--                  their balance is always derived with SUM() over entries.
CREATE TABLE accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 text NOT NULL CHECK (kind IN ('WALLET','SYSTEM')),
  user_id              uuid UNIQUE REFERENCES users(id),
  code                 text UNIQUE,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN')),
  balance              bigint NOT NULL DEFAULT 0,
  lifetime_earned      bigint NOT NULL DEFAULT 0,
  lifetime_spend_paise bigint NOT NULL DEFAULT 0,
  seq                  bigint NOT NULL DEFAULT 0,
  head_hash            text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_shape CHECK ((kind = 'WALLET' AND user_id IS NOT NULL AND code IS NULL)
                               OR (kind = 'SYSTEM' AND user_id IS NULL AND code IS NOT NULL)),
  CONSTRAINT wallet_never_negative CHECK (kind = 'SYSTEM' OR balance >= 0)
);

CREATE TABLE journals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN
                    ('EARN','REFERRAL','GRANT','REDEEM','EXPIRE','REVERSAL')),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,
  reversal_of     uuid REFERENCES journals(id),
  reference_type  text,
  reference_id    text,
  description     text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journals_idem_uq UNIQUE (account_id, idempotency_key)
);
-- A journal can be reversed at most once, even if application checks race or are bypassed.
CREATE UNIQUE INDEX journals_reversal_once_uq ON journals (reversal_of) WHERE reversal_of IS NOT NULL;

CREATE TABLE ledger_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  global_seq    bigint GENERATED ALWAYS AS IDENTITY,
  journal_id    uuid NOT NULL REFERENCES journals(id),
  account_id    uuid NOT NULL REFERENCES accounts(id),
  direction     text NOT NULL CHECK (direction IN ('CREDIT','DEBIT')),
  amount        bigint NOT NULL CHECK (amount > 0),
  seq           bigint,
  balance_after bigint,
  prev_hash     text,
  hash          text,
  created_at    timestamptz NOT NULL,
  CONSTRAINT chain_shape CHECK ((seq IS NULL AND hash IS NULL AND balance_after IS NULL)
                             OR (seq IS NOT NULL AND hash IS NOT NULL AND balance_after IS NOT NULL))
);
CREATE UNIQUE INDEX entries_wallet_seq_uq ON ledger_entries (account_id, seq) WHERE seq IS NOT NULL;
CREATE INDEX entries_journal_idx ON ledger_entries (journal_id);
CREATE INDEX entries_account_idx ON ledger_entries (account_id, global_seq DESC);

-- Immutability: no UPDATE, DELETE or TRUNCATE on the log. Ever.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER journals_immutable BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journals_no_truncate BEFORE TRUNCATE ON journals
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Double entry: at COMMIT every journal must have sum(credits) = sum(debits).
CREATE FUNCTION assert_journal_balanced() RETURNS trigger AS $$
DECLARE diff bigint;
BEGIN
  SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)
    INTO diff FROM ledger_entries WHERE journal_id = NEW.journal_id;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'journal % is unbalanced by %', NEW.journal_id, diff USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

-- Expiry: every credit to a wallet becomes a lot consumed soonest-expiring-first.
-- Lots are a projection (mutable); sum(remaining) must equal the wallet balance (audited).
CREATE TABLE point_lots (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id),
  journal_id uuid NOT NULL UNIQUE REFERENCES journals(id),
  initial    bigint NOT NULL CHECK (initial > 0),
  remaining  bigint NOT NULL CHECK (remaining >= 0 AND remaining <= initial),
  earned_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX lots_fifo_idx ON point_lots (account_id, expires_at) WHERE remaining > 0;
CREATE INDEX lots_expiry_idx ON point_lots (expires_at) WHERE remaining > 0;

-- ───────────────────────── business ─────────────────────────
CREATE TABLE payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id),
  category          text NOT NULL CHECK (category IN ('SHOPPING','RECHARGE','CREDIT_CARD_BILL','BILL_PAYMENT','RENT')),
  amount_paise      bigint NOT NULL CHECK (amount_paise > 0),
  description       text,
  status            text NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','REFUNDED')),
  points_awarded    bigint NOT NULL DEFAULT 0,
  rule_applied      text NOT NULL,
  reward_journal_id uuid REFERENCES journals(id),
  source            text NOT NULL DEFAULT 'SIMULATED' CHECK (source IN ('SIMULATED','WEBHOOK')),
  external_ref      text UNIQUE,
  idempotency_key   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_idem_uq UNIQUE (account_id, idempotency_key)
);
CREATE INDEX payments_account_idx ON payments (account_id, created_at DESC);

CREATE TABLE catalog_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  emoji       text NOT NULL DEFAULT '🎁',
  points_cost int  NOT NULL CHECK (points_cost > 0),
  stock       int  CHECK (stock IS NULL OR stock >= 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE redemptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id),
  item_id         uuid NOT NULL REFERENCES catalog_items(id),
  points_spent    bigint NOT NULL,
  voucher_code    text NOT NULL,
  journal_id      uuid NOT NULL REFERENCES journals(id),
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redemptions_idem_uq UNIQUE (account_id, idempotency_key)
);
CREATE INDEX redemptions_account_idx ON redemptions (account_id, created_at DESC);

-- ───────────────────────── admin governance ─────────────────────────
-- Maker-checker ("four eyes"): an admin can only REQUEST a grant / reversal / refund.
-- A DIFFERENT admin must approve it, and the database refuses self-approval.
CREATE TABLE approvals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('GRANT','REVERSAL','REFUND_PAYMENT')),
  account_id        uuid NOT NULL REFERENCES accounts(id),
  amount            bigint CHECK (amount IS NULL OR amount > 0),
  target_journal_id uuid REFERENCES journals(id),
  target_payment_id uuid REFERENCES payments(id),
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','EXECUTED','REJECTED')),
  requested_by      uuid NOT NULL REFERENCES users(id),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decision_note     text,
  result_journal_id uuid REFERENCES journals(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT four_eyes CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE INDEX approvals_status_idx ON approvals (status, created_at DESC);

CREATE TABLE admin_audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id   uuid REFERENCES users(id),
  action     text NOT NULL,
  target     text,
  details    jsonb NOT NULL DEFAULT '{}',
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ───────────────────────── notifications ─────────────────────────
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}',
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- Transactional outbox: written in the SAME transaction as the ledger entry, delivered later
-- by a worker with retries. A credit/debit can never commit without its email queued,
-- and an SMTP outage can never roll back or block a ledger write.
CREATE TABLE outbox (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  topic           text NOT NULL CHECK (topic IN ('EMAIL','REFERRAL_REWARD')),
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','DEAD')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX outbox_due_idx ON outbox (next_attempt_at) WHERE status = 'PENDING';

INSERT INTO accounts (kind, code) VALUES
  ('SYSTEM','ISSUANCE'),
  ('SYSTEM','REDEMPTION'),
  ('SYSTEM','EXPIRY');
