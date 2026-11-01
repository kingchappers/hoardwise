import { describe, expect, it } from 'vitest';
import type { Category, CategoryTarget, PotSummary, Transaction, TransactionType } from '../../api/types';
import { buildMonthReview, type ReviewInput } from '../review';

let seq = 0;
function tx(date: string, type: TransactionType, categoryId: string, amount: number, description = ''): Transaction {
  seq += 1;
  return {
    transactionId: `t${seq}`,
    yearMonth: date.slice(0, 7),
    amount,
    type,
    categoryId,
    description,
    date,
    createdAt: `${date}T00:00:00.000Z`,
  };
}

const cat = (categoryId: string, type: Category['type'] = 'EXPENSE'): Category => ({
  categoryId,
  name: categoryId,
  type,
  icon: 'circle',
  isDefault: false,
  createdAt: '2026-01-01T00:00:00.000Z',
});

const pot = (categoryId: string, overrides: Partial<PotSummary> = {}): PotSummary => ({
  categoryId,
  monthlyAmount: null,
  goalAmount: null,
  autoAmountNow: 0,
  archivedAt: null,
  balance: 10000,
  thisMonth: { setAside: 0, autoAdded: 0, takeOut: 0, spent: 0 },
  months: [],
  ...overrides,
});

const pad = (n: number): string => String(n).padStart(2, '0');
const PRIOR = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const PAST_NOW = new Date('2026-10-31T12:00:00Z');

// Eight days of small entries make a month count as having data (a quarter of its days).
const filler = (month: string): Transaction[] =>
  Array.from({ length: 8 }, (_, i) => tx(`${month}-${pad(i + 1)}`, 'EXPENSE', 'food', 100));

const each = (months: string[], make: (month: string) => Transaction[]): Transaction[] => months.flatMap(make);

const review = (overrides: Partial<ReviewInput>) =>
  buildMonthReview({
    month: '2026-09',
    now: PAST_NOW,
    categories: [cat('food'), cat('fun'), cat('salary', 'INCOME')],
    transactions: [],
    targets: [],
    pots: [],
    ...overrides,
  });

const line = (result: ReturnType<typeof buildMonthReview>, categoryId: string) =>
  result.categories.find((c) => c.categoryId === categoryId);

describe('buildMonthReview', () => {
  it('gives a new account with no data dataLevel none and no comparisons', () => {
    const result = review({ month: '2026-10', now: new Date('2026-10-20T12:00:00Z') });
    expect(result).toMatchObject({
      dataLevel: 'none',
      income: { logged: 0, hasLogged: false, usual: null, regularAmount: null },
      spending: { total: 0, usual: null },
      pots: [],
      notable: [],
      incomeQuestion: { ask: true, suggestedAmount: null },
    });
  });

  it('marks a past month as not in progress', () => {
    const result = review({ transactions: filler('2026-09') });
    expect(result).toMatchObject({ month: '2026-09', inProgress: false, throughDay: null });
  });

  it('makes no claims in the first week of the current month', () => {
    const transactions = [
      ...each(PRIOR.concat('2026-09'), (m) => [...filler(m), tx(`${m}-02`, 'EXPENSE', 'fun', 1000)]),
      tx('2026-10-01', 'EXPENSE', 'food', 100),
      tx('2026-10-02', 'EXPENSE', 'fun', 50000),
      tx('2026-10-03', 'EXPENSE', 'food', 100),
    ];
    const result = review({ month: '2026-10', now: new Date('2026-10-03T12:00:00Z'), transactions });
    expect(result).toMatchObject({ inProgress: true, throughDay: 3, dataLevel: 'little', notable: [] });
  });

  it('sums earlier months only up to the same day in a month in progress', () => {
    const transactions = [
      ...each(PRIOR.concat('2026-09'), (m) => [...filler(m), tx(`${m}-20`, 'EXPENSE', 'food', 5000)]),
      ...filler('2026-10'),
    ];
    const result = review({ month: '2026-10', now: new Date('2026-10-12T12:00:00Z'), transactions });
    expect(result.spending).toEqual({ total: 800, usual: 800 });
  });

  it('leaves entries after today out of a month in progress', () => {
    const transactions = [...filler('2026-10'), tx('2026-10-25', 'EXPENSE', 'food', 9000)];
    const result = review({ month: '2026-10', now: new Date('2026-10-12T12:00:00Z'), transactions });
    expect(result.spending.total).toBe(800);
  });

  it('judges a month in progress as little data when few of its days so far have entries', () => {
    const transactions = [1, 5, 9, 13].map((d) => tx(`2026-10-${pad(d)}`, 'EXPENSE', 'food', 100));
    const result = review({ month: '2026-10', now: new Date('2026-10-20T12:00:00Z'), transactions });
    expect(result.dataLevel).toBe('little');
  });

  it('judges a past month with entries on fewer than a quarter of its days as little data', () => {
    const transactions = filler('2026-09').slice(0, 7);
    expect(review({ transactions }).dataLevel).toBe('little');
  });

  it('uses logged income and asks no income question', () => {
    const transactions = [...filler('2026-09'), tx('2026-09-25', 'INCOME', 'salary', 230000)];
    const result = review({ transactions });
    expect(result).toMatchObject({
      income: { logged: 230000, hasLogged: true },
      incomeQuestion: { ask: false },
    });
  });

  it('asks the income question when no income is logged', () => {
    const result = review({ transactions: filler('2026-09') });
    expect(result.incomeQuestion.ask).toBe(true);
  });

  it('suggests a regular income amount', () => {
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-25`, 'INCOME', 'salary', 230000)]),
      ...filler('2026-09'),
    ];
    expect(review({ transactions }).incomeQuestion).toEqual({ ask: true, suggestedAmount: 230000 });
  });

  it('suggests the whole-month regular income even before payday in a month in progress', () => {
    const transactions = [
      ...each(PRIOR.concat('2026-09'), (m) => [...filler(m), tx(`${m}-25`, 'INCOME', 'salary', 230000)]),
      ...filler('2026-10'),
    ];
    const result = review({ month: '2026-10', now: new Date('2026-10-12T12:00:00Z'), transactions });
    expect(result.incomeQuestion.suggestedAmount).toBe(230000);
  });

  it('suggests no amount for irregular income', () => {
    const amounts = [100000, 230000, 180000, 90000, 260000, 150000];
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-25`, 'INCOME', 'salary', amounts[PRIOR.indexOf(m)])]),
      ...filler('2026-09'),
    ];
    expect(review({ transactions }).incomeQuestion).toEqual({ ask: true, suggestedAmount: null });
  });

  it('does not flag a category 1.51 times its usual with a £4.99 gap', () => {
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-10`, 'EXPENSE', 'fun', 980)]),
      ...filler('2026-09'),
      tx('2026-09-10', 'EXPENSE', 'fun', 1479),
    ];
    const result = review({ transactions });
    expect(result.notable).toEqual([]);
  });

  it('flags a category 1.51 times its usual with a £5.00 gap', () => {
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-10`, 'EXPENSE', 'fun', 980)]),
      ...filler('2026-09'),
      tx('2026-09-10', 'EXPENSE', 'fun', 1480),
    ];
    const result = review({ transactions });
    expect(result.notable).toEqual([
      { kind: 'category-above-usual', categoryId: 'fun', amount: 1480, gap: 500, text: '' },
    ]);
  });

  it('flags a big item with its dated description', () => {
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-10`, 'EXPENSE', 'fun', 1000), tx(`${m}-11`, 'EXPENSE', 'fun', 1000)]),
      ...filler('2026-09'),
      tx('2026-09-15', 'EXPENSE', 'fun', 5000, 'New boots'),
    ];
    const result = review({ transactions });
    expect(result.notable).toContainEqual({
      kind: 'big-item',
      categoryId: 'fun',
      amount: 5000,
      gap: 4000,
      text: '2026-09-15: New boots',
    });
  });

  it('cuts a big item description to 200 characters', () => {
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-10`, 'EXPENSE', 'fun', 1000)]),
      ...filler('2026-09'),
      tx('2026-09-15', 'EXPENSE', 'fun', 5000, 'x'.repeat(10000)),
    ];
    const big = review({ transactions }).notable.find((n) => n.kind === 'big-item');
    expect(big?.text).toHaveLength(200);
  });

  it('gives a big item with no description just its date', () => {
    const old = { ...tx('2026-09-15', 'EXPENSE', 'fun', 5000), description: undefined } as unknown as Transaction;
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-10`, 'EXPENSE', 'fun', 1000)]),
      ...filler('2026-09'),
      old,
    ];
    const big = review({ transactions }).notable.find((n) => n.kind === 'big-item');
    expect(big?.text).toBe('2026-09-15: ');
  });

  it('needs three earlier items before calling an item big', () => {
    const transactions = [
      ...each(PRIOR, filler),
      tx('2026-07-10', 'EXPENSE', 'fun', 1000),
      tx('2026-08-10', 'EXPENSE', 'fun', 1000),
      ...filler('2026-09'),
      tx('2026-09-15', 'EXPENSE', 'fun', 5000, 'New boots'),
    ];
    const kinds = review({ transactions }).notable.map((n) => n.kind);
    expect(kinds).not.toContain('big-item');
  });

  it('flags income well below its usual', () => {
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-25`, 'INCOME', 'salary', 230000)]),
      ...filler('2026-09'),
      tx('2026-09-25', 'INCOME', 'salary', 100000),
    ];
    expect(review({ transactions }).notable).toEqual([
      { kind: 'income-below-usual', categoryId: 'salary', amount: 100000, gap: 130000, text: '' },
    ]);
  });

  it('counts income dated after today as logged but not in the total so far', () => {
    const transactions = [...filler('2026-10'), tx('2026-10-28', 'INCOME', 'salary', 230000)];
    const result = review({ month: '2026-10', now: new Date('2026-10-12T12:00:00Z'), transactions });
    expect(result).toMatchObject({
      income: { logged: 0, hasLogged: true },
      incomeQuestion: { ask: false },
    });
  });

  it('makes no income-below-usual claim when no income is logged', () => {
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-25`, 'INCOME', 'salary', 230000)]),
      ...filler('2026-09'),
    ];
    expect(review({ transactions }).notable).toEqual([]);
  });

  it('does not flag income below usual when this month is paid only after today', () => {
    const transactions = [
      ...each(PRIOR.concat('2026-09'), (m) => [...filler(m), tx(`${m}-05`, 'INCOME', 'salary', 230000)]),
      ...filler('2026-10'),
      tx('2026-10-28', 'INCOME', 'salary', 230000),
    ];
    const result = review({ month: '2026-10', now: new Date('2026-10-12T12:00:00Z'), transactions });
    expect(result.notable).toEqual([]);
  });

  it('does not flag an income category paid after today when another is paid so far', () => {
    const transactions = [
      ...each(PRIOR.concat('2026-09'), (m) => [
        ...filler(m),
        tx(`${m}-05`, 'INCOME', 'salary', 230000),
        tx(`${m}-03`, 'INCOME', 'side', 20000),
      ]),
      ...filler('2026-10'),
      tx('2026-10-03', 'INCOME', 'side', 20000),
      tx('2026-10-28', 'INCOME', 'salary', 230000),
    ];
    const categories = [cat('food'), cat('salary', 'INCOME'), cat('side', 'INCOME')];
    const result = review({ month: '2026-10', now: new Date('2026-10-12T12:00:00Z'), transactions, categories });
    expect(result.notable).toEqual([]);
  });

  it('keeps at most three notable entries, largest gap first', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const halves = [1500, 2000, 2500, 3000];
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), ...ids.map((id) => tx(`${m}-10`, 'EXPENSE', id, 1000))]),
      ...filler('2026-09'),
      ...ids.flatMap((id, i) => [tx('2026-09-10', 'EXPENSE', id, halves[i]), tx('2026-09-11', 'EXPENSE', id, halves[i])]),
    ];
    const result = review({ transactions, categories: [cat('food'), ...ids.map((id) => cat(id))] });
    expect(result.notable.map((n) => [n.categoryId, n.gap])).toEqual([
      ['d', 5000],
      ['c', 4000],
      ['b', 3000],
    ]);
  });

  it('converts a weekly target to the month', () => {
    const targets: CategoryTarget[] = [
      { categoryId: 'fun', targetAmount: 7000, period: 'WEEKLY', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const result = review({ transactions: filler('2026-09'), targets });
    expect(line(result, 'fun')?.target).toBe(30000);
  });

  it('marks a category over its target', () => {
    const targets: CategoryTarget[] = [
      { categoryId: 'food', targetAmount: 500, period: 'MONTHLY', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const result = review({ transactions: filler('2026-09'), targets });
    expect(line(result, 'food')).toMatchObject({ thisMonth: 800, target: 500, overTarget: true });
  });

  it('gives a category with no target target null and overTarget false', () => {
    const result = review({ transactions: filler('2026-09') });
    expect(line(result, 'food')).toMatchObject({ target: null, overTarget: false });
  });

  it('counts a spend in a pot category in the month spending', () => {
    const transactions = [...filler('2026-09'), tx('2026-09-12', 'EXPENSE', 'holiday', 4000)];
    const result = review({ transactions, categories: [cat('food'), cat('holiday', 'POT')] });
    expect(result.spending.total).toBe(4800);
  });

  it('never compares a pot category spend with a target', () => {
    const targets: CategoryTarget[] = [
      { categoryId: 'holiday', targetAmount: 1000, period: 'MONTHLY', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const transactions = [...filler('2026-09'), tx('2026-09-12', 'EXPENSE', 'holiday', 4000)];
    const result = review({ transactions, targets, categories: [cat('food'), cat('holiday', 'POT')] });
    expect(line(result, 'holiday')).toMatchObject({ type: 'POT', thisMonth: 4000, target: null, overTarget: false });
  });

  it('still notes a pot category spend well above its usual', () => {
    const transactions = [
      ...each(PRIOR, (m) => [...filler(m), tx(`${m}-10`, 'EXPENSE', 'holiday', 1000)]),
      ...filler('2026-09'),
      tx('2026-09-10', 'EXPENSE', 'holiday', 1600),
    ];
    const result = review({ transactions, categories: [cat('food'), cat('holiday', 'POT')] });
    expect(result.notable).toEqual([
      { kind: 'category-above-usual', categoryId: 'holiday', amount: 1600, gap: 600, text: '' },
    ]);
  });

  it('lists a pot with movement this month', () => {
    const pots = [pot('holiday', { thisMonth: { setAside: 2000, autoAdded: 500, takeOut: 300, spent: 4000 } })];
    const result = review({ transactions: filler('2026-09'), pots, categories: [cat('holiday', 'POT')] });
    expect(result.pots).toEqual([
      { categoryId: 'holiday', name: 'holiday', added: 2500, takenOut: 300, spent: 4000, balance: 10000 },
    ]);
  });

  it('leaves out an archived pot', () => {
    const pots = [
      pot('holiday', { archivedAt: '2026-08-01T00:00:00.000Z', thisMonth: { setAside: 2000, autoAdded: 0, takeOut: 0, spent: 0 } }),
    ];
    const result = review({ transactions: filler('2026-09'), pots, categories: [cat('holiday', 'POT')] });
    expect(result.pots).toEqual([]);
  });

  it('leaves out a pot with no movement this month', () => {
    const result = review({ transactions: filler('2026-09'), pots: [pot('holiday')], categories: [cat('holiday', 'POT')] });
    expect(result.pots).toEqual([]);
  });
});
