import { describe, expect, it } from 'vitest';
import {
  median,
  monthHasData,
  monthlyTarget,
  regularAmount,
  sumToDay,
  throughDay,
  usualFor,
} from '../calc';

const days = (n: number): { date: string }[] =>
  Array.from({ length: n }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}` }));

const monthMap = (entries: [string, number][]): Map<string, number> => new Map(entries);

describe('median', () => {
  it('picks the middle value', () => expect(median([100, 300, 200])).toBe(200));
  it('averages the middle two', () => expect(median([100, 200])).toBe(150));
  it('rounds a half penny', () => expect(median([100, 201])).toBe(151));
  it('is null when empty', () => expect(median([])).toBeNull());
});

describe('monthHasData', () => {
  it('counts a quarter of the days as data', () => {
    expect(monthHasData(days(8), '2026-10')).toBe(true);
  });
  it('treats fewer than a quarter as no data', () => {
    expect(monthHasData(days(7), '2026-10')).toBe(false);
  });
  it('counts distinct days, not entries', () => {
    const sameDay = Array.from({ length: 20 }, () => ({ date: '2026-10-01' }));
    expect(monthHasData(sameDay, '2026-10')).toBe(false);
  });
  it('ignores entries in other months', () => {
    expect(monthHasData([...days(7), { date: '2026-09-30' }], '2026-10')).toBe(false);
  });
});

describe('usualFor', () => {
  const values = monthMap([
    ['2026-05', 100],
    ['2026-06', 200],
    ['2026-07', 300],
    ['2026-08', 400],
    ['2026-09', 500],
    ['2026-10', 9999],
  ]);

  it('excludes the month itself', () => {
    const data = new Set(values.keys());
    expect(usualFor(values, '2026-10', data)).toBe(300);
  });
  it('is null with two prior months', () => {
    expect(usualFor(values, '2026-07', new Set(['2026-05', '2026-06', '2026-07']))).toBeNull();
  });
  it('skips months without data', () => {
    const data = new Set(['2026-05', '2026-07', '2026-09']);
    expect(usualFor(values, '2026-10', data)).toBe(300);
  });
  it('uses only the six most recent months with data', () => {
    // Six months give a median of 1500; wrongly adding the seventh, oldest month makes it 1000.
    const many = monthMap([
      ['2026-01', 1],
      ['2026-02', 1000],
      ['2026-03', 1000],
      ['2026-04', 1000],
      ['2026-05', 2000],
      ['2026-06', 2000],
      ['2026-07', 2000],
    ]);
    expect(usualFor(many, '2026-08', new Set(many.keys()))).toBe(1500);
  });
  it('ignores later months', () => {
    expect(usualFor(values, '2026-08', new Set(values.keys()))).toBe(200);
  });
});

describe('monthlyTarget', () => {
  it('leaves a monthly target alone', () => {
    expect(monthlyTarget({ targetAmount: 5000, period: 'MONTHLY' }, '2026-10')).toBe(5000);
  });
  it('scales a weekly target to a 28-day month', () => {
    expect(monthlyTarget({ targetAmount: 7000, period: 'WEEKLY' }, '2026-02')).toBe(28000);
  });
  it('scales a weekly target to a 31-day month', () => {
    expect(monthlyTarget({ targetAmount: 7000, period: 'WEEKLY' }, '2026-10')).toBe(31000);
  });
  it('rounds to the nearest penny', () => {
    expect(monthlyTarget({ targetAmount: 1000, period: 'WEEKLY' }, '2026-10')).toBe(4429);
  });
});

describe('throughDay', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  it('is the day reached in the current month', () => expect(throughDay('2026-10', now)).toBe(12));
  it('is null for another month', () => expect(throughDay('2026-09', now)).toBeNull());
  it('uses the UTC date', () => {
    expect(throughDay('2026-10', new Date('2026-10-31T23:30:00Z'))).toBe(31);
  });
});

describe('sumToDay', () => {
  const entries = [
    { date: '2026-10-01', amount: 100 },
    { date: '2026-10-12', amount: 200 },
    { date: '2026-10-13', amount: 400 },
  ];
  it('ignores entries after the day', () => expect(sumToDay(entries, 12)).toBe(300));
  it('sums everything for null', () => expect(sumToDay(entries, null)).toBe(700));
});

describe('regularAmount', () => {
  const run = (amounts: number[]): number | null => {
    const months = amounts.map((_, i) => `2026-0${i + 1}`);
    const values = monthMap(months.map((m, i) => [m, amounts[i]]));
    return regularAmount(values, '2026-09', new Set(months));
  };
  it('accepts close amounts', () => expect(run([230000, 230000, 231000])).toBe(230000));
  it('rejects amounts that vary', () => expect(run([200000, 230000, 260000])).toBeNull());
  it('accepts a spread of exactly 5% and rejects a penny more', () => {
    expect(run([200000, 200000, 210000])).toBe(200000);
    expect(run([200000, 200000, 210001])).toBeNull();
  });
  it('needs three months', () => expect(run([230000, 230000])).toBeNull());
  it('ignores months without income', () => {
    expect(run([230000, 0, 230000, 230000])).toBe(230000);
  });
});
