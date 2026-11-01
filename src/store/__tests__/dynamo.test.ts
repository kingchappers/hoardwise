import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoStore } from '../dynamo';
import { ConditionFailedError } from '../types';

const send = vi.fn();
const store = new DynamoStore({ send }, 'test-table');
const PK = 'USER#u1';

function sentInput(call = 0): Record<string, any> {
  return send.mock.calls[call][0].input;
}

function awsError(name: string, extra: object = {}): Error {
  return Object.assign(new Error(name), { name, ...extra });
}

beforeEach(() => { send.mockReset(); });

describe('get', () => {
  it('sends only the key and returns the item', async () => {
    send.mockResolvedValueOnce({ Item: { PK, SK: 'CAT#a', name: 'Food' } });
    const item = await store.get({ PK, SK: 'CAT#a', extra: 'ignored' } as any);
    expect(sentInput()).toEqual({ TableName: 'test-table', Key: { PK, SK: 'CAT#a' } });
    expect(item).toEqual({ PK, SK: 'CAT#a', name: 'Food' });
  });

  it('asks for a consistent read only when told to', async () => {
    send.mockResolvedValue({});
    await store.get({ PK, SK: 'CAT#a' });
    await store.get({ PK, SK: 'CAT#a' }, { consistent: true });
    expect(sentInput(0).ConsistentRead).toBeUndefined();
    expect(sentInput(1).ConsistentRead).toBe(true);
  });

  it('returns undefined when there is no item', async () => {
    send.mockResolvedValueOnce({});
    expect(await store.get({ PK, SK: 'CAT#a' })).toBeUndefined();
  });
});

describe('put', () => {
  it('adds no condition by default', async () => {
    send.mockResolvedValueOnce({});
    await store.put({ PK, SK: 'CAT#a', name: 'Food' });
    expect(sentInput().ConditionExpression).toBeUndefined();
  });

  it('requires the item to be absent with ifAbsent', async () => {
    send.mockResolvedValueOnce({});
    await store.put({ PK, SK: 'CAT#a' }, { ifAbsent: true });
    expect(sentInput().ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('turns a failed condition into ConditionFailedError', async () => {
    send.mockRejectedValueOnce(awsError('ConditionalCheckFailedException'));
    await expect(store.put({ PK, SK: 'CAT#a' }, { ifAbsent: true })).rejects.toBeInstanceOf(ConditionFailedError);
  });

  it('lets other errors through unchanged', async () => {
    const boom = awsError('ProvisionedThroughputExceededException');
    send.mockRejectedValueOnce(boom);
    await expect(store.put({ PK, SK: 'CAT#a' })).rejects.toBe(boom);
  });
});

describe('patch', () => {
  it('aliases every attribute name, drops undefined and returns the new item', async () => {
    send.mockResolvedValueOnce({ Attributes: { PK, SK: 'PUSHSUB#x', hour: 8, auth: 'k' } });
    const item = await store.patch({ PK, SK: 'PUSHSUB#x' }, { hour: 8, auth: 'k', skipped: undefined });
    expect(sentInput()).toMatchObject({
      Key: { PK, SK: 'PUSHSUB#x' },
      UpdateExpression: 'SET #f0 = :f0, #f1 = :f1',
      ExpressionAttributeNames: { '#f0': 'hour', '#f1': 'auth' },
      ExpressionAttributeValues: { ':f0': 8, ':f1': 'k' },
      ReturnValues: 'ALL_NEW',
    });
    expect(sentInput().ConditionExpression).toBeUndefined();
    expect(item).toEqual({ PK, SK: 'PUSHSUB#x', hour: 8, auth: 'k' });
  });

  it('uses if_not_exists for defaults and attribute_exists for mustExist', async () => {
    send.mockResolvedValueOnce({ Attributes: { PK, SK: 'CAT#a' } });
    await store.patch({ PK, SK: 'CAT#a' }, { name: 'x' }, { mustExist: true, defaults: { createdAt: 'now' } });
    expect(sentInput().UpdateExpression).toBe('SET #f0 = :f0, #d0 = if_not_exists(#d0, :d0)');
    expect(sentInput().ConditionExpression).toBe('attribute_exists(PK)');
  });

  it('turns a failed condition into ConditionFailedError', async () => {
    send.mockRejectedValueOnce(awsError('ConditionalCheckFailedException'));
    await expect(store.patch({ PK, SK: 'CAT#a' }, { name: 'x' }, { mustExist: true }))
      .rejects.toBeInstanceOf(ConditionFailedError);
  });

  it('rejects an empty patch without calling DynamoDB', async () => {
    await expect(store.patch({ PK, SK: 'CAT#a' }, {})).rejects.toThrow('at least one field');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('delete', () => {
  it('requires the item to exist with ifPresent', async () => {
    send.mockResolvedValueOnce({});
    await store.delete({ PK, SK: 'CAT#a' }, { ifPresent: true });
    expect(sentInput()).toMatchObject({ Key: { PK, SK: 'CAT#a' }, ConditionExpression: 'attribute_exists(PK)' });
  });
});

describe('query', () => {
  it('queries the partition with no sort condition by default', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    await store.query(PK);
    expect(sentInput()).toMatchObject({
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'PK' },
      ExpressionAttributeValues: { ':pk': PK },
    });
  });

  it('treats an empty prefix as no sort condition', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    await store.query(PK, { skPrefix: '' });
    expect(sentInput().KeyConditionExpression).toBe('#pk = :pk');
  });

  it('uses begins_with for a prefix and equality for skEquals', async () => {
    send.mockResolvedValue({ Items: [] });
    await store.query(PK, { skPrefix: 'TXN#2026-10' });
    await store.query(PK, { skEquals: 'CAT#a' });
    expect(sentInput(0).KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :sk)');
    expect(sentInput(0).ExpressionAttributeValues).toEqual({ ':pk': PK, ':sk': 'TXN#2026-10' });
    expect(sentInput(1).KeyConditionExpression).toBe('#pk = :pk AND #sk = :sk');
  });

  it('aliases projected attributes', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    await store.query(PK, { skPrefix: 'POT#', attributes: ['SK', 'categoryId'] });
    expect(sentInput().ProjectionExpression).toBe('#p0, #p1');
    expect(sentInput().ExpressionAttributeNames).toMatchObject({ '#p0': 'SK', '#p1': 'categoryId' });
  });

  it('sends no projection for an empty attributes list', async () => {
    send.mockResolvedValueOnce({ Items: [] });
    await store.query(PK, { skPrefix: 'POT#', attributes: [] });
    expect(sentInput().ProjectionExpression).toBeUndefined();
    expect(sentInput().ExpressionAttributeNames).not.toHaveProperty('#p0');
  });

  it('follows LastEvaluatedKey until the last page', async () => {
    send
      .mockResolvedValueOnce({ Items: [{ PK, SK: 'A' }], LastEvaluatedKey: { PK, SK: 'A' } })
      .mockResolvedValueOnce({ Items: [{ PK, SK: 'B' }] });
    const items = await store.query(PK);
    expect(items.map(item => item.SK)).toEqual(['A', 'B']);
    expect(sentInput(0).ExclusiveStartKey).toBeUndefined();
    expect(sentInput(1).ExclusiveStartKey).toEqual({ PK, SK: 'A' });
  });

  it('rejects skPrefix and skEquals together', async () => {
    await expect(store.query(PK, { skPrefix: 'A', skEquals: 'B' })).rejects.toThrow('not both');
  });
});

describe('transact', () => {
  it('builds Put and Delete items with their conditions', async () => {
    send.mockResolvedValueOnce({});
    await store.transact([
      { delete: { PK, SK: 'A' }, ifPresent: true },
      { put: { PK, SK: 'B', n: 1 }, ifAbsent: true },
      { put: { PK, SK: 'C', n: 2 } },
    ]);
    expect(sentInput().TransactItems).toEqual([
      { Delete: { TableName: 'test-table', Key: { PK, SK: 'A' }, ConditionExpression: 'attribute_exists(PK)' } },
      { Put: { TableName: 'test-table', Item: { PK, SK: 'B', n: 1 }, ConditionExpression: 'attribute_not_exists(PK)' } },
      { Put: { TableName: 'test-table', Item: { PK, SK: 'C', n: 2 } } },
    ]);
  });

  it('reports the index of the operation whose condition failed', async () => {
    send.mockRejectedValueOnce(awsError('TransactionCanceledException', {
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    }));
    await expect(store.transact([{ put: { PK, SK: 'A' } }, { put: { PK, SK: 'B' }, ifAbsent: true }]))
      .rejects.toMatchObject({ name: 'ConditionFailedError', failedIndex: 1 });
  });

  it('lets a cancellation without a failed condition through unchanged', async () => {
    const conflict = awsError('TransactionCanceledException', { CancellationReasons: [{ Code: 'TransactionConflict' }] });
    send.mockRejectedValueOnce(conflict);
    await expect(store.transact([{ put: { PK, SK: 'A' } }])).rejects.toBe(conflict);
  });

  it('does not call DynamoDB for an empty list', async () => {
    await store.transact([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('fromEnv', () => {
  it('requires DYNAMODB_TABLE', () => {
    expect(() => DynamoStore.fromEnv({})).toThrow('DYNAMODB_TABLE');
  });

  it('builds a store when the table is named', () => {
    expect(DynamoStore.fromEnv({ DYNAMODB_TABLE: 'budget-data' })).toBeInstanceOf(DynamoStore);
  });
});
