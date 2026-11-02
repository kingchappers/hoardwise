import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { getStore } from '../store';
import { pk, expectedIncomeSk } from './db';
import { MAX_AMOUNT_PENCE } from './constants';
import type { ApiResponse } from './types';
import { ok, err, parseJsonObject } from './http';

export async function getExpectedIncome(
  _event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  const item = await getStore().get({ PK: pk(userId), SK: expectedIncomeSk });
  const amount = typeof item?.amount === 'number' ? item.amount : null;
  return ok({ amount });
}

export async function putExpectedIncome(
  event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  const body = parseJsonObject(event);
  if (!body) return err(400, 'Invalid JSON body');

  const { amount } = body;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0 || amount > MAX_AMOUNT_PENCE) {
    return err(400, `amount must be a positive integer representing pence/cents, at most ${MAX_AMOUNT_PENCE}`);
  }

  await getStore().put({ PK: pk(userId), SK: expectedIncomeSk, amount, updatedAt: new Date().toISOString() });
  return ok({ amount });
}

export async function deleteExpectedIncome(
  _event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  await getStore().delete({ PK: pk(userId), SK: expectedIncomeSk });
  return ok({ amount: null });
}
