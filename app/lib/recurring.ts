import type { RecurringInput } from './api';
import { parsePounds } from './money';
import { addDaysIso, daysBetweenIso, formatMonthName, formatShortDate, lastDayOfMonth, shiftMonth } from './months';
import type { Category, Recurring, RecurringFrequency, Transaction, TransactionType } from './types';

export type DueStatus = 'past' | 'today' | 'upcoming';

export interface DueItem {
  recurring: Recurring;
  period: string;
  dueDate: string;
  status: DueStatus;
  daysAway: number;
  likelyMatches: Transaction[];
}

export interface DueGroup {
  period: string;
  items: DueItem[];
}

export interface GroupedDueItems {
  current: DueItem[];
  older: DueGroup[];
}

export interface ComputeDueInput {
  recurring: Recurring[];
  categories: Category[];
  transactions: Transaction[];
  today: string;
}

export const LOOK_BACK_MONTHS = 3;

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const FREQUENCY_OPTIONS: { value: RecurringFrequency; label: string }[] = [
  { value: 'WEEKLY', label: 'Every week' },
  { value: 'FOUR_WEEKLY', label: 'Every 4 weeks' },
  { value: 'MONTHLY', label: 'Every month' },
  { value: 'QUARTERLY', label: 'Every 3 months' },
  { value: 'YEARLY', label: 'Every year' },
];

// Mirrors the API: how many days ahead a reminder may start for each schedule.
export const MAX_LEAD_DAYS: Record<RecurringFrequency, number> = {
  WEEKLY: 14,
  FOUR_WEEKLY: 14,
  MONTHLY: 30,
  QUARTERLY: 60,
  YEARLY: 60,
};

// Annual bills are the ones that rely most on remembering far ahead, so they start with a longer warning.
export const DEFAULT_LEAD_DAYS: Record<RecurringFrequency, number> = {
  WEEKLY: 2,
  FOUR_WEEKLY: 3,
  MONTHLY: 3,
  QUARTERLY: 14,
  YEARLY: 30,
};

const STEP_DAYS: Partial<Record<RecurringFrequency, number>> = { WEEKLY: 7, FOUR_WEEKLY: 28 };
const STEP_MONTHS: Partial<Record<RecurringFrequency, number>> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };
// Roughly how far apart occurrences are. Used to find which occurrence a logged transaction belongs to.
const SPACING_DAYS: Record<RecurringFrequency, number> = { WEEKLY: 7, FOUR_WEEKLY: 28, MONTHLY: 31, QUARTERLY: 92, YEARLY: 366 };
const MONTHS_BETWEEN: Partial<Record<RecurringFrequency, number>> = { QUARTERLY: 3, YEARLY: 12 };

type Schedule = Pick<Recurring, 'dayOfMonth' | 'frequency' | 'anchorDate'>;

export function frequencyOf(recurring: Pick<Recurring, 'frequency'>): RecurringFrequency {
  return recurring.frequency ?? 'MONTHLY';
}

// Monthly items are keyed by their month (YYYY-MM, as they always were);
// every other schedule is keyed by the date of the occurrence.
function isDated(recurring: Pick<Recurring, 'frequency'>): boolean {
  return frequencyOf(recurring) !== 'MONTHLY';
}

function monthIndex(yearMonth: string): number {
  const [year, month] = yearMonth.split('-').map(Number);
  return year * 12 + month - 1;
}

function daySteppedOccurrences(anchor: string, stepDays: number, from: string, to: string): string[] {
  const occurrences: string[] = [];
  const first = Math.ceil(daysBetweenIso(anchor, from) / stepDays) * stepDays;
  for (let offset = first; ; offset += stepDays) {
    const date = addDaysIso(anchor, offset);
    if (date > to) return occurrences;
    occurrences.push(date);
  }
}

function monthSteppedOccurrences(template: Schedule, stepMonths: number, from: string, to: string): string[] {
  const anchor = template.anchorDate;
  const dated = isDated(template);
  if (dated && !anchor) return [];
  const day = dated && anchor ? Number(anchor.slice(8, 10)) : template.dayOfMonth;
  const baseIndex = dated && anchor ? monthIndex(anchor.slice(0, 7)) : 0;

  const occurrences: string[] = [];
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); month = shiftMonth(month, 1)) {
    const monthsFromBase = monthIndex(month) - baseIndex;
    if (((monthsFromBase % stepMonths) + stepMonths) % stepMonths !== 0) continue;
    const date = dueDateFor(month, day);
    if (date >= from && date <= to) occurrences.push(date);
  }
  return occurrences;
}

// Every date the item falls due between from and to, inclusive and in order. A 31st
// lands on the last day of shorter months, and 29 February on the 28th in other years.
export function nextOccurrences(template: Schedule, from: string, to: string): string[] {
  if (from > to) return [];
  const frequency = frequencyOf(template);
  const stepDays = STEP_DAYS[frequency];
  if (stepDays !== undefined) {
    return template.anchorDate ? daySteppedOccurrences(template.anchorDate, stepDays, from, to) : [];
  }
  return monthSteppedOccurrences(template, STEP_MONTHS[frequency] ?? 1, from, to);
}

function nearestOccurrence(template: Schedule, date: string): string | null {
  const span = SPACING_DAYS[frequencyOf(template)];
  let nearest: string | null = null;
  let nearestGap = Infinity;
  for (const occurrence of nextOccurrences(template, addDaysIso(date, -span), addDaysIso(date, span))) {
    const gap = Math.abs(daysBetweenIso(occurrence, date));
    if (gap < nearestGap) {
      nearest = occurrence;
      nearestGap = gap;
    }
  }
  return nearest;
}

// The occurrence just before this one, used to put a skipped occurrence back.
export function previousOccurrenceKey(recurring: Recurring, key: string): string | null {
  if (!isDated(recurring)) return shiftMonth(key, -1);
  const span = SPACING_DAYS[frequencyOf(recurring)];
  const earlier = nextOccurrences(recurring, addDaysIso(key, -span), addDaysIso(key, -1));
  return earlier[earlier.length - 1] ?? null;
}

// The API only accepts a handled marker in the format of the item's schedule: a month for monthly, a real date otherwise.
function matchesFrequencyFormat(recurring: Pick<Recurring, 'frequency'>, key: string): boolean {
  return isDated(recurring) ? isRealDate(key) : PERIOD_PATTERN.test(key);
}

// The marker to send back when undoing a skip or an add. A row whose frequency changed before the API started clearing
// the marker can still hold the old format, which the API would answer with a 400, so it is reset to null instead.
export function restorablePeriod(recurring: Recurring): string | null {
  const { handledPeriod } = recurring;
  if (handledPeriod === null) return null;
  return matchesFrequencyFormat(recurring, handledPeriod) ? handledPeriod : null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function dueDateFor(period: string, dayOfMonth: number): string {
  return `${period}-${pad(Math.min(dayOfMonth, lastDayOfMonth(period)))}`;
}

function inPeriod(transaction: Transaction, period: string): boolean {
  return transaction.date.slice(0, 7) === period;
}

function isLoggedFor(recurring: Recurring, period: string, transaction: Transaction): boolean {
  if (transaction.recurringId !== recurring.recurringId) return false;
  if (!isDated(recurring)) return inPeriod(transaction, period);
  return nearestOccurrence(recurring, transaction.date) === period;
}

export function isHandled(recurring: Recurring, period: string, transactions: Transaction[]): boolean {
  if (recurring.handledPeriod !== null && recurring.handledPeriod >= period) return true;
  return transactions.some(t => isLoggedFor(recurring, period, t));
}

function isWithinTenPercent(amount: number, target: number): boolean {
  return Math.abs(amount - target) * 10 <= target;
}

function compareCandidates(target: number): (a: Transaction, b: Transaction) => number {
  return (a, b) => {
    const byDistance = Math.abs(a.amount - target) - Math.abs(b.amount - target);
    if (byDistance !== 0) return byDistance;
    return b.date.localeCompare(a.date);
  };
}

function matchWindow(recurring: Recurring): number {
  return Math.min(Math.floor(SPACING_DAYS[frequencyOf(recurring)] / 2), 30);
}

function isNearOccurrence(recurring: Recurring, occurrence: string, transaction: Transaction): boolean {
  return transaction.date >= addDaysIso(occurrence, -recurring.leadDays)
    && transaction.date <= addDaysIso(occurrence, matchWindow(recurring));
}

export function likelyMatches(recurring: Recurring, period: string, transactions: Transaction[]): Transaction[] {
  const dated = isDated(recurring);
  return transactions
    .filter(t =>
      (dated ? isNearOccurrence(recurring, period, t) : inPeriod(t, period))
      && t.recurringId === undefined
      && t.type === recurring.type
      && t.categoryId === recurring.categoryId
      && isWithinTenPercent(t.amount, recurring.amount))
    .sort(compareCandidates(recurring.amount));
}

function statusFor(daysAway: number): DueStatus {
  if (daysAway > 0) return 'upcoming';
  if (daysAway === 0) return 'today';
  return 'past';
}

function compareDue(a: DueItem, b: DueItem): number {
  if (a.daysAway !== b.daysAway) return a.daysAway - b.daysAway;
  const byNote = a.recurring.description.localeCompare(b.recurring.description);
  if (byNote !== 0) return byNote;
  return a.recurring.recurringId.localeCompare(b.recurring.recurringId);
}

function firstPeriodFor(template: Recurring, thisMonth: string): string {
  const earliest = shiftMonth(thisMonth, -LOOK_BACK_MONTHS);
  const created = template.createdAt.slice(0, 7);
  if (!PERIOD_PATTERN.test(created)) return earliest;
  return created > earliest ? created : earliest;
}

function isVisible(template: Recurring, period: string, dueDate: string, today: string): boolean {
  if (period < today.slice(0, 7)) return true;
  return today >= addDaysIso(dueDate, -template.leadDays);
}

function earliestDatedDue(template: Recurring, transactions: Transaction[], today: string): DueItem | null {
  const lookBackStart = `${shiftMonth(today.slice(0, 7), -LOOK_BACK_MONTHS)}-01`;
  const created = template.createdAt.slice(0, 10);
  const lowerBound = DATE_PATTERN.test(created) && created > lookBackStart ? created : lookBackStart;

  for (const date of nextOccurrences(template, lowerBound, addDaysIso(today, template.leadDays))) {
    if (isHandled(template, date, transactions)) continue;
    const daysAway = daysBetweenIso(today, date);
    return {
      recurring: template,
      period: date,
      dueDate: date,
      status: statusFor(daysAway),
      daysAway,
      likelyMatches: likelyMatches(template, date, transactions),
    };
  }
  return null;
}

function earliestDue(template: Recurring, transactions: Transaction[], today: string): DueItem | null {
  if (isDated(template)) return earliestDatedDue(template, transactions, today);
  const thisMonth = today.slice(0, 7);
  const lastPeriod = shiftMonth(thisMonth, 1);

  for (let period = firstPeriodFor(template, thisMonth); period <= lastPeriod; period = shiftMonth(period, 1)) {
    if (isHandled(template, period, transactions)) continue;
    const dueDate = dueDateFor(period, template.dayOfMonth);
    if (!isVisible(template, period, dueDate, today)) return null;

    const daysAway = daysBetweenIso(today, dueDate);
    return {
      recurring: template,
      period,
      dueDate,
      status: statusFor(daysAway),
      daysAway,
      likelyMatches: likelyMatches(template, period, transactions),
    };
  }
  return null;
}

export function computeDueItems({ recurring, categories, transactions, today }: ComputeDueInput): DueItem[] {
  const knownCategories = new Set(categories.map(c => c.categoryId));
  const items: DueItem[] = [];

  for (const template of recurring) {
    if (!knownCategories.has(template.categoryId)) continue;
    const item = earliestDue(template, transactions, today);
    if (item) items.push(item);
  }

  return items.sort(compareDue);
}

export function groupDueItems(items: DueItem[], today: string): GroupedDueItems {
  const thisMonth = today.slice(0, 7);
  const current: DueItem[] = [];
  const byPeriod = new Map<string, DueItem[]>();

  for (const item of items) {
    // Dated occurrences are grouped by their month, like monthly ones.
    const month = item.period.slice(0, 7);
    if (month >= thisMonth) {
      current.push(item);
      continue;
    }
    byPeriod.set(month, [...(byPeriod.get(month) ?? []), item]);
  }

  const older = [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, groupItems]) => ({ period, items: groupItems }));
  return { current, older };
}

export function skippedPeriod(recurring: Recurring, transactions: Transaction[], today: string): string | null {
  const period = recurring.handledPeriod;
  const thisMonth = today.slice(0, 7);
  if (period === null || period.slice(0, 7) < thisMonth || period.slice(0, 7) > shiftMonth(thisMonth, 1)) return null;
  const logged = transactions.some(t => isLoggedFor(recurring, period, t));
  return logged ? null : period;
}

// "September" for a monthly occurrence, "14 Mar" for a dated one.
export function occurrenceLabel(key: string): string {
  return PERIOD_PATTERN.test(key) ? formatMonthName(key) : formatShortDate(key);
}

export function olderGroupHeading(period: string): string {
  return `From ${formatMonthName(period)}`;
}

export function dueLabel(item: Pick<DueItem, 'status' | 'daysAway' | 'dueDate'>): string {
  if (item.status === 'today') return 'Due today';
  if (item.status === 'past') return `Due ${formatShortDate(item.dueDate)}`;

  const unit = item.daysAway === 1 ? 'day' : 'days';
  return `Due in ${item.daysAway} ${unit} · ${formatShortDate(item.dueDate)}`;
}

export function formatDayOfMonth(day: number): string {
  const lastTwo = day % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${day}th`;

  const suffixes: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
  return `${day}${suffixes[day % 10] ?? 'th'}`;
}

function weekdayName(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleString('en-GB', { weekday: 'long' });
}

function quarterlyMonths(anchor: string): string {
  const first = Number(anchor.slice(5, 7));
  return [0, 1, 2, 3]
    .map(step => formatMonthName(`2000-${pad(((first - 1 + step * 3) % 12) + 1)}`))
    .join(', ');
}

function describeRepeat(item: Recurring): string {
  const anchor = item.anchorDate ?? null;
  const day = anchor ? formatDayOfMonth(Number(anchor.slice(8, 10))) : formatDayOfMonth(item.dayOfMonth);

  switch (frequencyOf(item)) {
    case 'WEEKLY':
      return anchor ? `Every week on ${weekdayName(anchor)}` : 'Every week';
    case 'FOUR_WEEKLY':
      return anchor ? `Every 4 weeks on ${weekdayName(anchor)}, from ${formatShortDate(anchor)}` : 'Every 4 weeks';
    case 'QUARTERLY':
      return anchor ? `Every 3 months on the ${day} (${quarterlyMonths(anchor)})` : 'Every 3 months';
    case 'YEARLY':
      return anchor ? `Every year on ${Number(anchor.slice(8, 10))} ${formatMonthName(anchor.slice(0, 7))}` : 'Every year';
    default:
      return `Monthly on the ${day}`;
  }
}

// "Every year on 14 March · remind 30 days before"
export function describeSchedule(item: Recurring): string {
  const repeat = describeRepeat(item);
  if (item.leadDays === 0) return `${repeat} · no early reminder`;
  return `${repeat} · remind ${item.leadDays} ${item.leadDays === 1 ? 'day' : 'days'} before`;
}

// What to put aside each month so a quarterly or yearly bill is covered when it arrives,
// rounded up to the penny. Null for schedules that are already frequent.
export function monthlyPotAmount(amount: number, frequency: RecurringFrequency): number | null {
  const months = MONTHS_BETWEEN[frequency];
  return months === undefined ? null : Math.ceil(amount / months);
}

export interface RecurringFormValues {
  type: TransactionType;
  categoryId: string | null;
  amount: string;
  description: string;
  dayOfMonth: number | string;
  leadDays: number | string;
  // Missing means monthly.
  frequency?: RecurringFrequency;
  anchorDate?: string;
}

export type RecurringFormErrors = Partial<Record<'amount' | 'category' | 'description' | 'dayOfMonth' | 'anchorDate' | 'leadDays', string>>;

export type RecurringFormResult =
  | { ok: true; value: RecurringInput }
  | { ok: false; errors: RecurringFormErrors };

function toWholeNumber(value: number | string): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateRecurringForm(values: RecurringFormValues): RecurringFormResult {
  const errors: RecurringFormErrors = {};
  const frequency = values.frequency ?? 'MONTHLY';
  const monthly = frequency === 'MONTHLY';
  const anchorDate = values.anchorDate ?? '';

  const amount = parsePounds(values.amount);
  if (!amount.ok) errors.amount = amount.message;
  if (!values.categoryId) errors.category = 'Choose a category';

  const monthlyDay = toWholeNumber(values.dayOfMonth);
  if (monthly && (monthlyDay === null || monthlyDay < 1 || monthlyDay > 31)) errors.dayOfMonth = 'Enter a day from 1 to 31';
  if (!monthly && !isRealDate(anchorDate)) errors.anchorDate = 'Enter a date, for example 14/03/2026';

  const maxLead = MAX_LEAD_DAYS[frequency];
  const leadDays = toWholeNumber(values.leadDays);
  if (leadDays === null || leadDays < 0 || leadDays > maxLead) errors.leadDays = `Enter 0 to ${maxLead} days`;

  const description = values.description.trim();
  if (description.length > 200) errors.description = 'Note is too long';

  if (!amount.ok || !values.categoryId || leadDays === null || Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const day = monthly ? (monthlyDay as number) : Number(anchorDate.slice(8, 10));

  return {
    ok: true,
    value: {
      type: values.type,
      categoryId: values.categoryId,
      amount: amount.pence,
      description,
      dayOfMonth: day,
      frequency,
      anchorDate: monthly ? null : anchorDate,
      leadDays,
    },
  };
}
