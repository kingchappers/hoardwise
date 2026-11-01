import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { ConditionFailedError, getStore } from '../store';
import type { Store } from '../store';
import { pk, catSk } from './db';
import { DEFAULT_CATEGORIES, DEFAULT_CATEGORY_IDS } from './defaults';
import { SECURITY_HEADERS, VALID_CATEGORY_TYPES, VALID_CATEGORY_GROUPS, POT_GROUPS } from './constants';
import type { Category, CategoryGroup, CategoryType, ApiResponse } from './types';
import { ok, err, parseJsonObject } from './http';

// The one list of categories: the defaults plus the person's own, with archived pots marked.
// Shared by GET /api/categories and the MCP tools so they cannot drift apart.
export async function loadCategories(store: Store, userId: string): Promise<Category[]> {
  const [customItems, potItems] = await Promise.all(
    ['CAT#', 'POT#'].map(prefix => store.query(pk(userId), { skPrefix: prefix })),
  );

  const archivedIds = new Set(
    potItems
      .filter(item => typeof item.archivedAt === 'string')
      .map(item => String(item.categoryId)),
  );
  const custom = customItems.map(toCategory);
  return [...DEFAULT_CATEGORIES, ...custom].map(category => (
    archivedIds.has(category.categoryId) ? { ...category, archived: true } : category
  ));
}

export async function getCategories(
  _event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  return ok({ categories: await loadCategories(getStore(), userId) });
}

function toCategory(item: Record<string, unknown>): Category {
  const category: Category = {
    categoryId: String(item.categoryId),
    name: String(item.name),
    type: item.type as CategoryType,
    icon: typeof item.icon === 'string' ? item.icon : 'default',
    isDefault: Boolean(item.isDefault),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
  };
  if (typeof item.group === 'string') category.group = item.group as CategoryGroup;
  return category;
}

function defaultGroupFor(type: CategoryType): CategoryGroup | undefined {
  if (type === 'INCOME') return undefined;
  if (type === 'POT') return 'SINKING_FUNDS';
  return 'EVERYDAY';
}

function validateCategoryName(name: unknown): { ok: true; value: string } | { ok: false } {
  if (typeof name !== 'string') return { ok: false };
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return { ok: false };
  return { ok: true, value: trimmed };
}

export async function createCategory(
  event: APIGatewayProxyEventV2,
  userId: string,
  _params: Record<string, string>,
): Promise<ApiResponse> {
  const body = parseJsonObject(event);
  if (!body) return err(400, 'Invalid JSON body');

  const { name, type, icon, group } = body;

  const validName = validateCategoryName(name);
  if (!validName.ok) {
    return err(400, 'name must be a non-empty string of at most 50 characters');
  }
  if (!type || !VALID_CATEGORY_TYPES.has(type as string)) {
    return err(400, 'type must be EXPENSE, INCOME, or POT');
  }
  if (group !== undefined) {
    if (type === 'INCOME') {
      return err(400, 'group is not allowed for INCOME categories');
    }
    if (typeof group !== 'string' || !VALID_CATEGORY_GROUPS.has(group)) {
      return err(400, 'group must be BILLS, SINKING_FUNDS, EVERYDAY, or SAVING_INVESTMENT');
    }
    if (type === 'POT' && !POT_GROUPS.has(group)) {
      return err(400, 'POT categories must use the SINKING_FUNDS or SAVING_INVESTMENT group');
    }
    if (type === 'EXPENSE' && POT_GROUPS.has(group)) {
      return err(400, 'EXPENSE categories cannot use the SINKING_FUNDS or SAVING_INVESTMENT group');
    }
  }

  const resolvedGroup = (group as CategoryGroup | undefined) ?? defaultGroupFor(type as CategoryType);
  const categoryId = crypto.randomUUID();
  const category: Category = {
    categoryId,
    name: validName.value,
    type: type as Category['type'],
    icon: typeof icon === 'string' ? icon.slice(0, 50) : 'default',
    isDefault: false,
    createdAt: new Date().toISOString(),
  };
  if (resolvedGroup) category.group = resolvedGroup;

  await getStore().put({ PK: pk(userId), SK: catSk(categoryId), ...category });

  return { statusCode: 201, headers: SECURITY_HEADERS, body: JSON.stringify({ category }) };
}

export async function deleteCategory(
  _event: APIGatewayProxyEventV2,
  userId: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const { categoryId } = params;

  if (!categoryId) {
    return err(400, 'categoryId is required');
  }
  if (DEFAULT_CATEGORY_IDS.has(categoryId)) {
    return err(403, 'Cannot delete a default category');
  }

  await getStore().delete({ PK: pk(userId), SK: catSk(categoryId) });

  return { statusCode: 204, headers: SECURITY_HEADERS, body: '' };
}

export async function updateCategory(
  event: APIGatewayProxyEventV2,
  userId: string,
  params: Record<string, string>,
): Promise<ApiResponse> {
  const { categoryId } = params;

  if (!categoryId) {
    return err(400, 'categoryId is required');
  }
  if (DEFAULT_CATEGORY_IDS.has(categoryId)) {
    return err(403, 'Cannot rename a default category');
  }

  const body = parseJsonObject(event);
  if (!body) return err(400, 'Invalid JSON body');

  const validName = validateCategoryName(body.name);
  if (!validName.ok) {
    return err(400, 'name must be a non-empty string of at most 50 characters');
  }

  try {
    const item = await getStore().patch(
      { PK: pk(userId), SK: catSk(categoryId) },
      { name: validName.value },
      { mustExist: true },
    );
    return ok({ category: toCategory(item) });
  } catch (error) {
    if (error instanceof ConditionFailedError) return err(404, 'Category not found');
    throw error;
  }
}
