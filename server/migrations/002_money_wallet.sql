-- Pointwise schema v2: a rupee (INR) wallet next to the points wallet, plus the treasury.
-- Same ledger engine: append-only, hash-chained wallet entries, deferred double-entry check.
-- Money is stored as integer paise. Points and rupees never share a journal.

ALTER TABLE accounts ADD COLUMN currency text NOT NULL DEFAULT 'PTS' CHECK (currency IN ('PTS','INR'));

-- A user now has one wallet PER currency.
ALTER TABLE accounts DROP CONSTRAINT accounts_user_id_key;
CREATE UNIQUE INDEX accounts_user_currency_uq ON accounts (user_id, currency) WHERE kind = 'WALLET';

-- Wallets and the TREASURY may never go negative (so the reward pool can never be overdrawn).
-- Other system accounts are pure counters and may be negative.
ALTER TABLE accounts DROP CONSTRAINT wallet_never_negative;
ALTER TABLE accounts ADD CONSTRAINT balance_never_negative CHECK (balance >= 0 OR (kind = 'SYSTEM' AND code <> 'TREASURY'));

INSERT INTO accounts (kind, code, currency) VALUES
  ('SYSTEM', 'CONVERTED', 'PTS'),   -- points that were converted into wallet money
  ('SYSTEM', 'TREASURY',  'INR'),   -- THE ROOT ACCOUNT: reward pool that pays out conversions (locked, balance-checked)
  ('SYSTEM', 'FUNDS_IN',  'INR'),   -- real money received from outside (gateway top-ups, treasury funding)
  ('SYSTEM', 'MERCHANTS', 'INR');   -- money paid to merchants/bills from wallets

-- Everyone starts with ₹0.
INSERT INTO accounts (kind, user_id, currency) SELECT 'WALLET', id, 'INR' FROM users;

ALTER TABLE journals DROP CONSTRAINT journals_kind_check;
ALTER TABLE journals ADD CONSTRAINT journals_kind_check CHECK (kind IN
  ('EARN','REFERRAL','GRANT','REDEEM','EXPIRE','REVERSAL',
   'CONVERT','CONVERT_CREDIT','TOPUP','TRANSFER','WALLET_PAY','WALLET_REFUND','TREASURY_FUND'));

ALTER TABLE otps DROP CONSTRAINT otps_purpose_check;
ALTER TABLE otps ADD CONSTRAINT otps_purpose_check CHECK (purpose IN ('VERIFY_EMAIL','RESET_PASSWORD','REDEEM','MONEY'));

ALTER TABLE payments ADD COLUMN method text NOT NULL DEFAULT 'EXTERNAL' CHECK (method IN ('EXTERNAL','WALLET'));
ALTER TABLE payments ADD COLUMN wallet_journal_id uuid REFERENCES journals(id);

ALTER TABLE approvals DROP CONSTRAINT approvals_kind_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_kind_check CHECK (kind IN ('GRANT','REVERSAL','REFUND_PAYMENT','TREASURY_FUND'));

-- Points → money conversions (one row ties the points debit to the rupee credit).
CREATE TABLE conversions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id),
  points          bigint NOT NULL CHECK (points > 0),
  paise           bigint NOT NULL CHECK (paise > 0),
  paise_per_point int NOT NULL,
  points_journal_id uuid NOT NULL REFERENCES journals(id),
  money_journal_id  uuid NOT NULL REFERENCES journals(id),
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversions_idem_uq UNIQUE (user_id, idempotency_key)
);
CREATE INDEX conversions_user_idx ON conversions (user_id, created_at DESC);
