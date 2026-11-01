import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { planPatch } from './patch';
import {
  ConditionFailedError, type Item, type Key, type PatchOptions, type QueryOptions, type Store, type TxOp,
} from './types';

export interface Sender {
  send(command: any): Promise<any>;
}

const MUST_BE_ABSENT = 'attribute_not_exists(PK)';
const MUST_BE_PRESENT = 'attribute_exists(PK)';

function keyOf(key: Key): Key {
  return { PK: key.PK, SK: key.SK };
}

function conditional(expression: string | undefined): { ConditionExpression?: string } {
  return expression ? { ConditionExpression: expression } : {};
}

function translate(error: unknown): unknown {
  if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
    return new ConditionFailedError();
  }
  return error;
}

function translateTransaction(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return error;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  const failed = reasons.findIndex(reason => reason.Code === 'ConditionalCheckFailed');
  return failed >= 0 ? new ConditionFailedError(failed) : error;
}

export class DynamoStore implements Store {
  constructor(private readonly client: Sender, private readonly table: string) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): DynamoStore {
    const table = env.DYNAMODB_TABLE;
    if (!table) {
      throw new Error('DYNAMODB_TABLE is required when STORE=dynamodb');
    }
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: env.AWS_REGION || 'eu-west-2' }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
    return new DynamoStore(client, table);
  }

  async get(key: Key, opts: { consistent?: boolean } = {}): Promise<Item | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.table,
      Key: keyOf(key),
      ...(opts.consistent ? { ConsistentRead: true } : {}),
    }));
    return result.Item as Item | undefined;
  }

  async put(item: Item, opts: { ifAbsent?: boolean } = {}): Promise<void> {
    try {
      await this.client.send(new PutCommand({
        TableName: this.table,
        Item: item,
        ...conditional(opts.ifAbsent ? MUST_BE_ABSENT : undefined),
      }));
    } catch (error) {
      throw translate(error);
    }
  }

  async patch(key: Key, fields: Record<string, unknown>, opts: PatchOptions = {}): Promise<Item> {
    const plan = planPatch(fields, opts.defaults);
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const assignments: string[] = [];

    plan.fields.forEach(([name, value], index) => {
      names[`#f${index}`] = name;
      values[`:f${index}`] = value;
      assignments.push(`#f${index} = :f${index}`);
    });
    plan.defaults.forEach(([name, value], index) => {
      names[`#d${index}`] = name;
      values[`:d${index}`] = value;
      assignments.push(`#d${index} = if_not_exists(#d${index}, :d${index})`);
    });

    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.table,
        Key: keyOf(key),
        UpdateExpression: `SET ${assignments.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...conditional(opts.mustExist ? MUST_BE_PRESENT : undefined),
        ReturnValues: 'ALL_NEW',
      }));
      return result.Attributes as Item;
    } catch (error) {
      throw translate(error);
    }
  }

  async delete(key: Key, opts: { ifPresent?: boolean } = {}): Promise<void> {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.table,
        Key: keyOf(key),
        ...conditional(opts.ifPresent ? MUST_BE_PRESENT : undefined),
      }));
    } catch (error) {
      throw translate(error);
    }
  }

  async query(pk: string, opts: QueryOptions = {}): Promise<Item[]> {
    if (opts.skPrefix !== undefined && opts.skEquals !== undefined) {
      throw new Error('query takes skPrefix or skEquals, not both');
    }

    const names: Record<string, string> = { '#pk': 'PK' };
    const values: Record<string, unknown> = { ':pk': pk };
    let condition = '#pk = :pk';
    if (opts.skEquals !== undefined) {
      names['#sk'] = 'SK';
      values[':sk'] = opts.skEquals;
      condition += ' AND #sk = :sk';
    } else if (opts.skPrefix) {
      names['#sk'] = 'SK';
      values[':sk'] = opts.skPrefix;
      condition += ' AND begins_with(#sk, :sk)';
    }

    let projection: { ProjectionExpression: string } | Record<string, never> = {};
    if (opts.attributes?.length) {
      opts.attributes.forEach((name, index) => { names[`#p${index}`] = name; });
      projection = { ProjectionExpression: opts.attributes.map((_, index) => `#p${index}`).join(', ') };
    }

    const items: Item[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...projection,
        ExclusiveStartKey: startKey,
      }));
      items.push(...((result.Items ?? []) as Item[]));
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  async transact(ops: TxOp[]): Promise<void> {
    if (ops.length === 0) return;
    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: ops.map(op => ('put' in op
          ? { Put: { TableName: this.table, Item: op.put, ...conditional(op.ifAbsent ? MUST_BE_ABSENT : undefined) } }
          : { Delete: { TableName: this.table, Key: keyOf(op.delete), ...conditional(op.ifPresent ? MUST_BE_PRESENT : undefined) } })),
      }));
    } catch (error) {
      throw translateTransaction(error);
    }
  }
}
