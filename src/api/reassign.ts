import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ConditionFailedError, getStore } from '../store';
import { pk, catSk } from './db';
import { DEFAULT_CATEGORY_IDS } from './defaults';
import { ok, err, parseJsonObject } from './http';
import type { ApiResponse } from './types';

const UPDATE_BATCH_SIZE = 25;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function reassignItems(
  userId: string,
  prefix: string,
  categoryId: string,
  toCategoryId: string,
): Promise<number> {
  const store = getStore();
  const items = await store.query(pk(userId), { skPrefix: prefix });
  const matching = items.filter(item => item.categoryId === categoryId);

  let reassigned = 0;
  for (const batch of chunk(matching, UPDATE_BATCH_SIZE)) {
    const results = await Promise.all(batch.map(async (item) => {
      try {
        await store.patch({ PK: pk(userId), SK: item.SK }, { categoryId: toCategoryId }, { mustExist: true });
        return true;
      } catch (error) {
        if (error instanceof ConditionFailedError) return false;
        throw error;
      }
    }));
    reassigned += results.filter(Boolean).length;
  }

  return reassigned;
}

async function categoryExists(userId: string, categoryId: string): Promise<boolean> {
  if (DEFAULT_CATEGORY_IDS.has(categoryId)) return true;
  return Boolean(await getStore().get({ PK: pk(userId), SK: catSk(categoryId) }));
}

export async function reassignCategory(
  event: APIGatewayProxyEventV2,
  userId: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const { categoryId } = params;

  if (!categoryId) {
    return err(400, 'categoryId is required');
  }
  if (!(await categoryExists(userId, categoryId))) {
    return err(404, 'Category not found');
  }

  const body = parseJsonObject(event);
  if (!body) return err(400, 'Invalid JSON body');

  const toCategoryId = body.toCategoryId;
  if (!toCategoryId || typeof toCategoryId !== 'string') {
    return err(400, 'toCategoryId is required');
  }
  if (toCategoryId === categoryId) {
    return err(400, 'toCategoryId must differ from the category being reassigned');
  }

  if (!(await categoryExists(userId, toCategoryId))) {
    return err(400, 'toCategoryId does not exist');
  }

  const reassigned = await reassignItems(userId, 'TXN#', categoryId, toCategoryId);
  const recurringReassigned = await reassignItems(userId, 'RECUR#', categoryId, toCategoryId);

  return ok({ reassigned, recurringReassigned });
}
