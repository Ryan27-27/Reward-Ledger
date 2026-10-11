// Reward policy as pure, unit-testable code. Money is integer paise, points are integers,
// multipliers are basis points — no floating point anywhere near the ledger.

export const CATEGORIES = {
  SHOPPING:         { label: 'Shopping',         rate: 8 },
  RECHARGE:         { label: 'Recharge',         rate: 6 },
  CREDIT_CARD_BILL: { label: 'Credit card bill', rate: 5 },
  BILL_PAYMENT:     { label: 'Bill payment',     rate: 4 },
  RENT:             { label: 'Rent',             rate: 3 },
};

// minSpendPaise = lifetime spend needed; multBp = multiplier in basis points (10000 = 1.00×)
export const TIERS = [
  { name: 'BRONZE',   minSpendPaise: 0,           multBp: 10000 },
  { name: 'SILVER',   minSpendPaise: 1_000_000,   multBp: 12500 }, // ₹10,000
  { name: 'GOLD',     minSpendPaise: 5_000_000,   multBp: 15000 }, // ₹50,000
  { name: 'PLATINUM', minSpendPaise: 20_000_000,  multBp: 20000 }, // ₹2,00,000
];

export const MAX_POINTS_PER_PAYMENT = 10_000;
export const FIRST_PAYMENT_BONUS = 50;

export function tierFor(lifetimeSpendPaise) {
  let t = TIERS[0];
  for (const tier of TIERS) if (lifetimeSpendPaise >= tier.minSpendPaise) t = tier;
  return t;
}

export function tierProgress(lifetimeSpendPaise) {
  const current = tierFor(lifetimeSpendPaise);
  const next = TIERS[TIERS.indexOf(current) + 1] || null;
  if (!next) return { current: current.name, next: null, remainingPaise: 0, pct: 100 };
  const span = next.minSpendPaise - current.minSpendPaise;
  return {
    current: current.name,
    next: next.name,
    remainingPaise: next.minSpendPaise - lifetimeSpendPaise,
    pct: Math.min(100, Math.floor(((lifetimeSpendPaise - current.minSpendPaise) * 100) / span)),
  };
}

const inr = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
export const formatInr = inr;

/**
 * points = floor( amount/₹100 × category rate × tier multiplier ), capped, + first-payment bonus.
 * The tier is taken from spend BEFORE this payment, so a payment can't upgrade the tier it is rewarded under.
 */
export function computeReward({ category, amountPaise, lifetimeSpendPaise, isFirstPayment }) {
  const cat = CATEGORIES[category];
  if (!cat) throw new Error(`unknown category ${category}`);
  const tier = tierFor(lifetimeSpendPaise);
  // amountPaise/10000 = number of ₹100 blocks; keep everything integral until the final floor.
  const uncapped = Math.floor((amountPaise * cat.rate * tier.multBp) / (10000 * 10000));
  const base = Math.min(uncapped, MAX_POINTS_PER_PAYMENT);
  const bonus = isFirstPayment ? FIRST_PAYMENT_BONUS : 0;
  const mult = (tier.multBp / 10000).toFixed(2).replace(/0$/, '');
  const explanation =
    `${cat.label}: ${cat.rate} pts per ₹100 × ${tier.name[0] + tier.name.slice(1).toLowerCase()} ${mult}× = ${base} pts` +
    (uncapped > base ? ` (capped at ${MAX_POINTS_PER_PAYMENT.toLocaleString('en-IN')})` : '') +
    (bonus ? ` + ${bonus} first-payment bonus` : '');
  return { points: base + bonus, base, bonus, tier: tier.name, explanation };
}

export function publicRules() {
  return {
    categories: Object.entries(CATEGORIES).map(([key, v]) => ({ key, ...v })),
    tiers: TIERS.map((t) => ({ name: t.name, minSpendPaise: t.minSpendPaise, multiplier: t.multBp / 10000 })),
    maxPointsPerPayment: MAX_POINTS_PER_PAYMENT,
    firstPaymentBonus: FIRST_PAYMENT_BONUS,
  };
}
