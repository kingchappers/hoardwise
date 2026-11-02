// An invented household for the About page screenshots. Nothing here is real. Dates are worked out from
// "now", so Home always looks current. Money is in pence, as in the app.

const DAY_MS = 86_400_000;

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function ym(date) {
  return iso(date).slice(0, 7);
}

function daysAgo(now, days) {
  return new Date(now.getTime() - days * DAY_MS);
}

// The streaming bill falls three days ahead, which only stays inside this month up to the 25th. Later in the
// month the run is dated the 15th instead, so Home always has a bill coming due.
export function referenceNow(real = new Date()) {
  if (real.getUTCDate() <= 25) return real;
  return new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth(), 15, 12));
}

// The day each month the streaming bill falls on: three days from now.
function streamingDay(now) {
  return Math.min(28, new Date(now.getTime() + 3 * DAY_MS).getUTCDate());
}

function monthStart(now, delta) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + delta, 1));
}

const CREATED_AT = '2026-01-01T00:00:00.000Z';

const category = (categoryId, name, type, icon, group) => ({
  categoryId, name, type, icon, ...(group ? { group } : {}), isDefault: true, createdAt: CREATED_AT,
});

const CATEGORIES = [
  category('cat-mortgage', 'Mortgage', 'EXPENSE', '🏠', 'BILLS'),
  category('cat-phone-internet', 'Phone and Internet', 'EXPENSE', '🛜', 'BILLS'),
  category('cat-subscriptions', 'Subscriptions', 'EXPENSE', '🗓️', 'BILLS'),
  category('cat-utilities', 'Utilities', 'EXPENSE', '⚡', 'BILLS'),
  category('cat-holidays', 'Holidays', 'POT', '✈️', 'SINKING_FUNDS'),
  category('cat-gifts', 'Gifts', 'POT', '🎁', 'SINKING_FUNDS'),
  category('cat-going-out', 'Going Out & Entertainment', 'EXPENSE', '🎡', 'EVERYDAY'),
  category('cat-groceries', 'Groceries', 'EXPENSE', '🛒', 'EVERYDAY'),
  category('cat-health', 'Health', 'EXPENSE', '🏥', 'EVERYDAY'),
  category('cat-transport', 'Transport', 'EXPENSE', '🛞', 'EVERYDAY'),
  category('cat-emergency-fund', 'Emergency fund', 'POT', '😌', 'SAVING_INVESTMENT'),
  category('cat-investment', 'Investment', 'POT', '📈', 'SAVING_INVESTMENT'),
  category('cat-salary', 'Salary', 'INCOME', 'briefcase'),
];

let nextId = 1;
const tx = (date, type, categoryId, amount, description, extra = {}) => ({
  transactionId: `demo-${String(nextId++).padStart(4, '0')}`,
  yearMonth: iso(date).slice(0, 7),
  amount, type, categoryId, description, date: iso(date), createdAt: `${iso(date)}T09:00:00.000Z`, ...extra,
});

// Everyday spending drifts from month to month so the trend chart is not a straight line. Fixed bills
// (mortgage, phone, streaming) and income stay the same.
const MONTH_FACTOR = { '-5': 1.12, '-4': 0.93, '-3': 1.04, '-2': 1.18, '-1': 0.96, '0': 1 };
const FIXED = new Set(['cat-mortgage', 'cat-phone-internet', 'cat-subscriptions', 'cat-salary', 'cat-holidays', 'cat-emergency-fund']);

function buildTransactions(now) {
  const rows = [];
  for (const delta of [-5, -4, -3, -2, -1, 0]) {
    const start = monthStart(now, delta);
    const day = d => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), d));
    const lastDay = delta === 0 ? now.getUTCDate() : 28;
    const on = d => (d <= lastDay ? day(d) : null);
    const add = (d, type, categoryId, amount, ...rest) => {
      const date = on(d);
      if (!date) return;
      const scaled = FIXED.has(categoryId) ? amount : Math.round(amount * MONTH_FACTOR[String(delta)]);
      rows.push(tx(date, type, categoryId, scaled, ...rest));
    };
    add(1, 'INCOME', 'cat-salary', 215000, 'Salary');
    add(1, 'EXPENSE', 'cat-mortgage', 78000, 'Mortgage', { recurringId: 'rec-mortgage' });
    add(2, 'EXPENSE', 'cat-phone-internet', 3200, 'Phone and broadband');
    add(3, 'EXPENSE', 'cat-groceries', 6420, 'Weekly shop');
    add(streamingDay(now), 'EXPENSE', 'cat-subscriptions', 1599, 'Streaming', { recurringId: 'rec-streaming' });
    add(6, 'EXPENSE', 'cat-transport', 4500, 'Train season top-up');
    add(8, 'EXPENSE', 'cat-going-out', 2850, 'Dinner out');
    add(10, 'EXPENSE', 'cat-groceries', 5870, 'Weekly shop');
    add(12, 'EXPENSE', 'cat-utilities', 9400, 'Gas and electric');
    add(14, 'EXPENSE', 'cat-health', 1200, 'Pharmacy');
    add(15, 'SET_ASIDE', 'cat-holidays', 15000, 'Holiday pot');
    add(15, 'SET_ASIDE', 'cat-emergency-fund', 10000, 'Emergency fund');
    add(17, 'EXPENSE', 'cat-groceries', 6105, 'Weekly shop');
    add(19, 'EXPENSE', 'cat-going-out', 1850, 'Cinema');
    add(22, 'EXPENSE', 'cat-transport', 2300, 'Taxi home');
    add(24, 'EXPENSE', 'cat-groceries', 5990, 'Weekly shop');
    add(26, 'EXPENSE', 'cat-gifts', 3500, 'Birthday present');
  }
  // A few in the last days so Home and Transactions have something from "today".
  rows.push(tx(now, 'EXPENSE', 'cat-groceries', 1840, 'Corner shop'));
  rows.push(tx(daysAgo(now, 1), 'EXPENSE', 'cat-going-out', 1260, 'Coffee with a friend'));
  return rows;
}

function buildPots(now) {
  const month = ym(now);
  const pot = (categoryId, balance, monthlyAmount, goalAmount) => ({
    categoryId, monthlyAmount, goalAmount, autoAmountNow: 0, archivedAt: null, balance,
    thisMonth: { setAside: monthlyAmount ?? 0, autoAdded: 0, takeOut: 0, spent: 0 },
    months: [{ yearMonth: month, opening: balance - (monthlyAmount ?? 0), setAside: monthlyAmount ?? 0, autoAdded: 0, takeOut: 0, spent: 0, closing: balance }],
  });
  return [pot('cat-holidays', 84000, 15000, 150000), pot('cat-emergency-fund', 310000, 10000, 500000)];
}

function buildRecurring(now) {
  // Created six months ago with earlier months confirmed, so Home shows one bill coming up and nothing missed.
  const created = `${iso(monthStart(now, -5))}T09:00:00.000Z`;
  const base = { frequency: 'MONTHLY', anchorDate: null, leadDays: 5, createdAt: created, updatedAt: created, type: 'EXPENSE' };
  return [
    { ...base, recurringId: 'rec-mortgage', categoryId: 'cat-mortgage', amount: 78000, description: 'Mortgage', dayOfMonth: 1, handledPeriod: ym(now) },
    { ...base, recurringId: 'rec-streaming', categoryId: 'cat-subscriptions', amount: 1599, description: 'Streaming', dayOfMonth: streamingDay(now), handledPeriod: ym(monthStart(now, -1)) },
  ];
}

function buildAccounts(now) {
  const balances = pence => [{ date: iso(daysAgo(now, 2)), pence }];
  return [
    { accountId: 'acc-current', name: 'Current account', kind: 'ASSET', type: 'CASH', balances: balances(184250), createdAt: CREATED_AT },
    { accountId: 'acc-savings', name: 'Savings', kind: 'ASSET', type: 'SAVINGS', balances: balances(1250000), createdAt: CREATED_AT },
    { accountId: 'acc-card', name: 'Credit card', kind: 'LIABILITY', type: 'CREDIT_CARD', balances: balances(42000), createdAt: CREATED_AT },
  ];
}

function buildTargets() {
  const t = (categoryId, targetAmount) => ({ categoryId, targetAmount, period: 'MONTHLY', updatedAt: CREATED_AT });
  return [t('cat-groceries', 30000), t('cat-going-out', 10000), t('cat-transport', 8000), t('cat-health', 5000)];
}

export function createStore(now = new Date()) {
  const transactions = buildTransactions(now);
  const state = {
    categories: CATEGORIES,
    targets: buildTargets(),
    pots: buildPots(now),
    recurring: buildRecurring(now),
    accounts: buildAccounts(now),
  };

  function handle(method, pathname, params, body) {
    const key = `${method} ${pathname}`;
    switch (key) {
      case 'GET /api/categories': return { status: 200, json: { categories: state.categories } };
      case 'GET /api/targets': return { status: 200, json: { targets: state.targets } };
      case 'GET /api/pots': return { status: 200, json: { pots: state.pots } };
      case 'GET /api/recurring': return { status: 200, json: { recurring: state.recurring } };
      case 'GET /api/accounts': return { status: 200, json: { accounts: state.accounts } };
      case 'GET /api/expected-income': return { status: 200, json: { amount: 215000 } };
      case 'GET /api/trash': return { status: 200, json: { items: [] } };
      case 'GET /api/tokens': return { status: 200, json: { tokens: [] } };
      case 'GET /api/transactions': {
        const wanted = `${params.get('year')}-${String(params.get('month')).padStart(2, '0')}`;
        return { status: 200, json: { transactions: transactions.filter(row => row.yearMonth === wanted) } };
      }
      case 'GET /api/transactions/range': {
        const from = params.get('from');
        const to = params.get('to');
        return { status: 200, json: { transactions: transactions.filter(row => row.yearMonth >= from && row.yearMonth <= to) } };
      }
      case 'POST /api/transactions': {
        const created = tx(now, body.type, body.categoryId, body.amount, body.description ?? '');
        transactions.push(created);
        return { status: 201, json: { transaction: created } };
      }
      default:
        return { status: 404, json: { error: `No fixture for ${key}` } };
    }
  }

  return { handle };
}
