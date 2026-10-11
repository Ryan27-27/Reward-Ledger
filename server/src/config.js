import 'dotenv/config';

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

function secret(name, devDefault) {
  const v = env[name];
  if (v && v.length >= 32) return v;
  if (isProd) throw new Error(`${name} must be set to at least 32 characters in production`);
  return devDefault;
}

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  env: env.NODE_ENV || 'development',
  isProd,
  isTest,
  port: int(env.PORT, 4000),
  databaseUrl: env.DATABASE_URL || 'postgres://pointwise:pointwise@127.0.0.1:5432/pointwise',
  autoMigrate: (env.AUTO_MIGRATE ?? (isProd ? 'false' : 'true')) === 'true',
  trustProxy: int(env.TRUST_PROXY, 0),
  corsOrigins: (env.CORS_ORIGINS || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  appUrl: env.APP_URL || 'http://localhost:5173',

  jwtSecret: secret('JWT_SECRET', 'dev-only-jwt-secret-change-me-0123456789abcdef'),
  otpSecret: secret('OTP_SECRET', 'dev-only-otp-secret-change-me-0123456789abcdef'),
  webhookSecret: secret('WEBHOOK_SECRET', 'dev-only-webhook-secret-change-me-0123456789ab'),
  accessTtlSec: int(env.ACCESS_TTL_SEC, 15 * 60),
  refreshTtlDays: int(env.REFRESH_TTL_DAYS, 30),
  refreshReuseGraceSec: int(env.REFRESH_REUSE_GRACE_SEC, 10),
  cookieSecure: (env.COOKIE_SECURE ?? (isProd ? 'true' : 'false')) === 'true',

  smtpUrl: env.SMTP_URL || '',
  mailFrom: env.MAIL_FROM || 'Pointwise <no-reply@pointwise.local>',
  workersEnabled: (env.WORKERS_ENABLED ?? 'true') === 'true',
  outboxPollMs: int(env.OUTBOX_POLL_MS, 2000),
  outboxMaxAttempts: int(env.OUTBOX_MAX_ATTEMPTS, 8),
  expiryPollMs: int(env.EXPIRY_POLL_MS, 60 * 60 * 1000),

  // Real money can only enter via the signed gateway webhook in production. The simulated "add money" and
  // simulated card/UPI payment are demo conveniences: OFF by default in production (they would mint free money).
  simulatedPayments: (env.ALLOW_SIMULATED_PAYMENTS ?? (isProd ? 'false' : 'true')) === 'true',

  vpaDomain: (env.VPA_DOMAIN || 'pointwise').toLowerCase().replace(/[^a-z0-9-]/g, ''),

  metricsToken: env.METRICS_TOKEN || '',
  swaggerEnabled: !isProd,

  rewards: {
    expiryMonths: int(env.POINTS_EXPIRY_MONTHS, 12),
    stepUpThreshold: int(env.STEP_UP_THRESHOLD_POINTS, 1000), // redemptions >= this need an emailed OTP
    maxGrantPoints: int(env.MAX_GRANT_POINTS, 50_000),
    maxPaymentPaise: int(env.MAX_PAYMENT_PAISE, 50_000_000), // ₹5,00,000
    firstBonusMinPaise: int(env.FIRST_PAYMENT_BONUS_MIN_PAISE, 10_000), // the first-payment bonus needs a payment of at least ₹100 (blocks ₹1 sign-up farming)
    referralBonus: int(env.REFERRAL_BONUS_POINTS, 100),
  },
  wallet: {
    maxBalancePaise: int(env.WALLET_MAX_BALANCE_PAISE, 5_000_000),     // ₹50,000
    maxTopupPaise: int(env.WALLET_MAX_TOPUP_PAISE, 2_500_000),         // ₹25,000 per top-up
    maxTransferPaise: int(env.WALLET_MAX_TRANSFER_PAISE, 2_500_000),   // ₹25,000 per transfer
    dailyOutboundPaise: int(env.WALLET_DAILY_OUTBOUND_PAISE, 5_000_000), // ₹50,000 / rolling 24h (transfers + wallet payments)
    transferStepUpPaise: int(env.WALLET_TRANSFER_STEP_UP_PAISE, 200_000), // transfers >= ₹2,000 need an emailed code
    maxTreasuryFundPaise: int(env.TREASURY_MAX_FUND_PAISE, 100_000_000), // ₹10,00,000 per funding request
  },
  conversion: {
    paisePerPoint: int(env.CONVERSION_PAISE_PER_POINT, 3),   // 100 points = ₹3  →  3 paise per point
    blockPoints: int(env.CONVERSION_BLOCK_POINTS, 100),      // convert in multiples of 100 points
    dailyLimitPoints: int(env.CONVERSION_DAILY_LIMIT_POINTS, 50_000), // 50,000 points (₹1,500) / rolling 24h
  },
  otp: { ttlMin: 10, maxAttempts: 5, maxPerHour: 5 },
  login: { maxFailures: 5, lockMinutes: 15 },
};
