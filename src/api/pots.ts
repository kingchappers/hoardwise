import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getStore } from '../store';
import { pk, catSk, potSk } from './db';
import { MAX_AMOUNT_PENCE } from './constants';
import { DEFAULT_CATEGORIES } from './defaults';
import { autoAmountFor, computePots } from './potsCalc';
import type { ApiResponse, Category, PotAutoEntry, PotSettings, Transaction } from './types';
import { ok, err, parseJsonObject } from './http';

export const MAX_AUTO_ENTRIES = 120;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH_PATTERN.test(value);
}

export function monthIndex(yearMonth: string): number {
  const [year, month] = yearMonth.split('-').map(Number);
  return year * 12 + (month - 1);
}

export function serverMonthIndex(): number {
  const now = new Date();
  return now.getUTCFullYear() * 12 + now.getUTCMonth();
}

function isOptionalAmount(value: unknown): value is number | null {
  if (value === null) return true;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_AMOUNT_PENCE;
}

export async function queryAll(userId: string, prefix: string): Promise<Record<string, unknown>[]> {
  return getStore().query(pk(userId), { skPrefix: prefix });
}

export async function queryOne(userId: string, sk: string): Promise<Record<string, unknown> | undefined> {
  return getStore().get({ PK: pk(userId), SK: sk });
}

export function toSettings(item: Record<string, unknown>): PotSettings {
  return {
    categoryId: String(item.categoryId),
    monthlyAmount: typeof item.monthlyAmount === 'number' ? item.monthlyAmount : null,
    goalAmount: typeof item.goalAmount === 'number' ? item.goalAmount : null,
    autoContribute: Array.isArray(item.autoContribute) ? (item.autoContribute as PotAutoEntry[]) : [],
    archivedAt: typeof item.archivedAt === 'string' ? item.archivedAt : null,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  };
}

export function applyAutoContribute(
  existing: PotAutoEntry[],
  enabled: boolean,
  monthlyAmount: number | null,
  month: string,
): PotAutoEntry[] {
  const kept = existing.filter(entry => entry.from < month);
  const desired = enabled ? (monthlyAmount ?? 0) : 0;
  if (autoAmountFor(kept, month) === desired) return kept;
  return [...kept, { from: month, amount: desired }];
}

export async function getPots(
  event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  const asOf = event.queryStringParameters?.asOf;
  if (!isValidMonth(asOf) || monthIndex(asOf) > serverMonthIndex() + 1) {
    return err(400, 'asOf must be a month in YYYY-MM format, at most one month ahead');
  }

  const [customCategories, settingsItems, transactionItems] = await Promise.all([
    queryAll(userId, 'CAT#'),
    queryAll(userId, 'POT#'),
    queryAll(userId, 'TXN#'),
  ]);
  const categories = [...DEFAULT_CATEGORIES, ...(customCategories as unknown as Category[])];
  const potCategoryIds = categories.filter(c => c.type === 'POT').map(c => c.categoryId);
  const pots = computePots({
    transactions: transactionItems as unknown as Transaction[],
    potCategoryIds,
    settings: settingsItems.map(toSettings),
    asOfMonth: asOf,
  });
  return ok({ pots });
}

export async function findCategory(userId: string, categoryId: string): Promise<Category | undefined> {
  const builtIn = DEFAULT_CATEGORIES.find(c => c.categoryId === categoryId);
  if (builtIn) return builtIn;
  return (await queryOne(userId, catSk(categoryId))) as Category | undefined;
}

/** Looks the pot up before any body is validated: unknown id is 404, an existing non-pot category is 400. */
export async function potCategoryError(userId: string, categoryId: string): Promise<ApiResponse | null> {
  const category = await findCategory(userId, categoryId);
  if (!category) return err(404, 'Category not found');
  if (category.type !== 'POT') return err(400, 'categoryId must be an existing pot category');
  return null;
}

export async function putPot(
  event: APIGatewayProxyEventV2,
  userId: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const { categoryId } = params;
  if (!categoryId) {
    return err(400, 'categoryId is required');
  }

  const notAPot = await potCategoryError(userId, categoryId);
  if (notAPot) return notAPot;

  const body = parseJsonObject(event);
  if (!body) return err(400, 'Invalid JSON body');

  const { monthlyAmount, goalAmount, autoContribute, month } = body;
  if (!isOptionalAmount(monthlyAmount)) {
    return err(400, 'monthlyAmount must be null or a positive integer of pence');
  }
  if (!isOptionalAmount(goalAmount)) {
    return err(400, 'goalAmount must be null or a positive integer of pence');
  }
  if (typeof autoContribute !== 'boolean') {
    return err(400, 'autoContribute must be a boolean');
  }
  if (!isValidMonth(month) || Math.abs(monthIndex(month) - serverMonthIndex()) > 1) {
    return err(400, 'month must be a YYYY-MM month within one month of now');
  }
  if (autoContribute && monthlyAmount === null) {
    return err(400, 'autoContribute needs a monthlyAmount');
  }

  const existingItem = await queryOne(userId, potSk(categoryId));
  const existing = existingItem ? toSettings(existingItem) : undefined;
  if (existing?.archivedAt) return err(409, 'Unarchive this pot before changing it');

  const entries = applyAutoContribute(existing?.autoContribute ?? [], autoContribute, monthlyAmount, month);
  if (entries.length > MAX_AUTO_ENTRIES) {
    return err(400, 'Too many auto-contribute changes for this pot');
  }

  const settings: PotSettings = {
    categoryId,
    monthlyAmount,
    goalAmount,
    autoContribute: entries,
    archivedAt: null,
    updatedAt: new Date().toISOString(),
  };
  await getStore().put({ PK: pk(userId), SK: potSk(categoryId), ...settings });
  return ok({ settings });
}
