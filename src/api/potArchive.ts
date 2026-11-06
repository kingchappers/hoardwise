import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getStore } from '../store';
import { pk, potSk, recurringSk } from './db';
import { DEFAULT_CATEGORIES } from './defaults';
import { ok, err, parseJsonObject } from './http';
import {
  applyAutoContribute, isValidMonth, monthIndex, potCategoryError, queryAll, queryOne, serverMonthIndex, toSettings,
} from './pots';
import { computePots } from './potsCalc';
import { moveToTrash } from './trash';
import type { ApiResponse, Category, PotSettings, Transaction } from './types';

function parseMonth(event: APIGatewayProxyEventV2): string | null {
  const body = parseJsonObject(event);
  if (!body) return null;
  if (Object.keys(body).some(key => key !== 'month')) return null;
  const { month } = body;
  if (!isValidMonth(month) || Math.abs(monthIndex(month) - serverMonthIndex()) > 1) return null;
  return month;
}

async function loadPotSettings(userId: string, categoryId: string): Promise<PotSettings | undefined> {
  const item = await queryOne(userId, potSk(categoryId));
  return item ? toSettings(item) : undefined;
}

async function savePotSettings(userId: string, settings: PotSettings): Promise<void> {
  await getStore().put({ PK: pk(userId), SK: potSk(settings.categoryId), ...settings });
}

async function balanceWithoutAuto(
  userId: string,
  settings: PotSettings,
  month: string,
): Promise<number> {
  const [customCategories, transactions] = await Promise.all([
    queryAll(userId, 'CAT#'),
    queryAll(userId, 'TXN#'),
  ]);
  const categories = [...DEFAULT_CATEGORIES, ...(customCategories as unknown as Category[])];
  const [pot] = computePots({
    transactions: transactions as unknown as Transaction[],
    potCategoryIds: categories.filter(c => c.categoryId === settings.categoryId).map(c => c.categoryId),
    settings: [settings],
    asOfMonth: month,
  });
  return pot.balance;
}

async function cancelRecurring(userId: string, categoryId: string): Promise<number> {
  const items = await queryAll(userId, 'RECUR#');
  const owned = items.filter(item => item.categoryId === categoryId);
  for (const item of owned) {
    await moveToTrash(userId, 'RECURRING', recurringSk(String(item.recurringId)));
  }
  return owned.length;
}

export async function archivePot(
  event: APIGatewayProxyEventV2,
  userId: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const { categoryId } = params;
  if (!categoryId) return err(400, 'categoryId is required');

  const notAPot = await potCategoryError(userId, categoryId);
  if (notAPot) return notAPot;

  const month = parseMonth(event);
  if (month === null) return err(400, 'Body must be { month } as a YYYY-MM month within one month of now');

  const existing = await loadPotSettings(userId, categoryId);
  const stopped: PotSettings = {
    categoryId,
    monthlyAmount: existing?.monthlyAmount ?? null,
    goalAmount: existing?.goalAmount ?? null,
    autoContribute: applyAutoContribute(existing?.autoContribute ?? [], false, null, month),
    archivedAt: existing?.archivedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const balance = await balanceWithoutAuto(userId, stopped, month);
  if (balance !== 0) {
    return err(409, 'Take the balance out of this pot before archiving it', { balance });
  }

  const cancelledRecurring = await cancelRecurring(userId, categoryId);
  await savePotSettings(userId, stopped);
  return ok({ settings: stopped, cancelledRecurring });
}

export async function unarchivePot(
  _event: APIGatewayProxyEventV2,
  userId: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const { categoryId } = params;
  if (!categoryId) return err(400, 'categoryId is required');

  const notAPot = await potCategoryError(userId, categoryId);
  if (notAPot) return notAPot;

  const existing = await loadPotSettings(userId, categoryId);
  if (!existing?.archivedAt) return err(409, 'This pot is not archived');

  const settings: PotSettings = {
    ...existing,
    archivedAt: null,
    updatedAt: new Date().toISOString(),
  };
  await savePotSettings(userId, settings);
  return ok({ settings });
}
