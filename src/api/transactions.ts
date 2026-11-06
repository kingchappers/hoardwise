import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getStore } from '../store';
import { pk, txnSk } from './db';
import { MAX_AMOUNT_PENCE, SECURITY_HEADERS, VALID_TRANSACTION_TYPES } from './constants';
import type { Transaction, ApiResponse } from './types';
import { ok, err, parseJsonObject } from './http';
import { moveToTrash } from './trash';
import { isCalendarDate, isYearMonth } from './dates';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toTransaction(item: Record<string, unknown>): Transaction {
  const transaction: Transaction = {
    transactionId: item.transactionId as string,
    yearMonth: item.yearMonth as string,
    amount: item.amount as number,
    type: item.type as Transaction['type'],
    categoryId: item.categoryId as string,
    description: item.description as string,
    date: item.date as string,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
  };
  if (typeof item.recurringId === 'string') transaction.recurringId = item.recurringId;
  return transaction;
}

export async function getTransactions(
  event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  const qs = event.queryStringParameters || {};
  const { year, month } = qs;

  if (!year || !month) {
    return err(400, 'year and month query parameters are required');
  }

  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month)) {
    return err(400, 'Invalid year or month');
  }
  const yearNum = Number(year);
  const monthNum = Number(month);
  if (monthNum < 1 || monthNum > 12 || yearNum < 2000) {
    return err(400, 'Invalid year or month');
  }

  const yearMonth = `${year}-${month.padStart(2, '0')}`;

  const transactions = await getStore().query(pk(userId), { skPrefix: `TXN#${yearMonth}` });
  return ok({ transactions: transactions.map(toTransaction) });
}

export interface ValidTransactionInput {
  amount: number;
  type: Transaction['type'];
  categoryId: string;
  description: string;
  date: string;
  /** A UUID to link, `null` to unlink (PUT), absent to leave as it is. */
  recurringId?: string | null;
}

function isValidRecurringId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && UUID_PATTERN.test(value);
}

export function validateTransactionInput(
  body: Record<string, unknown>,
): { ok: true; value: ValidTransactionInput } | { ok: false; message: string } {
  const { amount, type, categoryId, description, date, recurringId } = body;

  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_PENCE) {
    return { ok: false, message: `amount must be a positive integer representing pence/cents, at most ${MAX_AMOUNT_PENCE}` };
  }
  if (!type || !VALID_TRANSACTION_TYPES.has(type as string)) {
    return { ok: false, message: 'type must be EXPENSE, INCOME, SET_ASIDE, or TAKE_OUT' };
  }
  if (!categoryId || typeof categoryId !== 'string' || categoryId.length > 100) {
    return { ok: false, message: 'categoryId is required' };
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string' || description.length > 200) {
      return { ok: false, message: 'description must be a string of at most 200 characters' };
    }
  }
  if (!isCalendarDate(date)) {
    return { ok: false, message: 'date must be a real date in YYYY-MM-DD format' };
  }
  if (recurringId !== undefined && recurringId !== null && !isValidRecurringId(recurringId)) {
    return { ok: false, message: 'recurringId must be a valid UUID' };
  }

  const value: ValidTransactionInput = {
    amount,
    type: type as Transaction['type'],
    categoryId,
    description: typeof description === 'string' ? description.trim() : '',
    date,
  };
  if (recurringId !== undefined) value.recurringId = recurringId;
  return { ok: true, value };
}

export async function createTransaction(
  event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  const body = parseJsonObject(event);
  if (!body) return err(400, 'Invalid JSON body');

  const validation = validateTransactionInput(body);
  if (validation.ok === false) {
    return err(400, validation.message);
  }
  const { amount, type, categoryId, description, date, recurringId } = validation.value;

  const clientTransactionId = body.transactionId;
  if (clientTransactionId !== undefined && (typeof clientTransactionId !== 'string' || !UUID_PATTERN.test(clientTransactionId))) {
    return err(400, 'transactionId must be a valid UUID');
  }

  const yearMonth = date.slice(0, 7);
  const transactionId = typeof clientTransactionId === 'string' ? clientTransactionId : crypto.randomUUID();

  const transaction: Transaction = {
    transactionId,
    yearMonth,
    amount,
    type,
    categoryId,
    description,
    date,
    createdAt: new Date().toISOString(),
  };
  if (typeof recurringId === 'string') transaction.recurringId = recurringId;

  await getStore().put({ PK: pk(userId), SK: txnSk(yearMonth, transactionId), ...transaction });

  return { statusCode: 201, headers: SECURITY_HEADERS, body: JSON.stringify({ transaction }) };
}

export async function deleteTransaction(
  _event: APIGatewayProxyEventV2,
  userId: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const { yearMonth, transactionId } = params;

  if (!isYearMonth(yearMonth)) {
    return err(400, 'yearMonth must be in YYYY-MM format');
  }
  if (!transactionId) {
    return err(400, 'transactionId is required');
  }

  await moveToTrash(userId, 'TRANSACTION', txnSk(yearMonth, transactionId));

  return { statusCode: 204, headers: SECURITY_HEADERS, body: '' };
}

export async function updateTransaction(
  event: APIGatewayProxyEventV2,
  userId: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const { yearMonth, transactionId } = params;

  if (!isYearMonth(yearMonth)) {
    return err(400, 'yearMonth must be in YYYY-MM format');
  }
  if (!transactionId) {
    return err(400, 'transactionId is required');
  }

  const store = getStore();
  const existing = (await store.get({ PK: pk(userId), SK: txnSk(yearMonth, transactionId) })) as unknown as Transaction | undefined;
  if (!existing) {
    return err(404, 'Transaction not found');
  }

  const body = parseJsonObject(event);
  if (!body) return err(400, 'Invalid JSON body');

  const validation = validateTransactionInput(body);
  if (validation.ok === false) {
    return err(400, validation.message);
  }
  const { amount, type, categoryId, description, date, recurringId } = validation.value;

  const newYearMonth = date.slice(0, 7);
  const transaction: Transaction = {
    transactionId,
    yearMonth: newYearMonth,
    amount,
    type,
    categoryId,
    description,
    date,
    createdAt: existing.createdAt,
  };
  const linkedRecurringId = recurringId === undefined ? existing.recurringId : recurringId;
  if (typeof linkedRecurringId === 'string') transaction.recurringId = linkedRecurringId;

  if (newYearMonth === yearMonth) {
    await store.put({ PK: pk(userId), SK: txnSk(yearMonth, transactionId), ...transaction });
  } else {
    await store.transact([
      { delete: { PK: pk(userId), SK: txnSk(yearMonth, transactionId) } },
      { put: { PK: pk(userId), SK: txnSk(newYearMonth, transactionId), ...transaction } },
    ]);
  }

  return ok({ transaction });
}
