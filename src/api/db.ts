export const pk = (userId: string): string => `USER#${userId}`;
export const catSk = (categoryId: string): string => `CAT#${categoryId}`;
export const txnSk = (yearMonth: string, transactionId: string): string =>
  `TXN#${yearMonth}#${transactionId}`;
export const targetSk = (categoryId: string): string => `TARGET#${categoryId}`;
export const recurringSk = (recurringId: string): string => `RECUR#${recurringId}`;
export const potSk = (categoryId: string): string => `POT#${categoryId}`;
export const accountSk = (accountId: string): string => `ACCOUNT#${accountId}`;

// Push reminders: each device's subscription lives in the user's own partition, and a
// small index in a partition of its own lets the scheduler find subscribed users with one Query.
export const PUSH_INDEX_PK = 'PUSHIDX';
export const pushSubscriptionSk = (endpointHash: string): string => `PUSHSUB#${endpointHash}`;
export const pushIndexSk = (userId: string): string => `USER#${userId}`;

// Saved graphic styles: one row per style, plus one marker naming the default (so there can never be two).
export const styleSk = (styleId: string): string => `STYLE#${styleId}`;
// One row per style name (lowercased), written with ifAbsent: it is what keeps names unique under concurrency.
export const styleNameSk = (name: string): string => `STYLENAME#${name.trim().toLowerCase()}`;
export const STYLE_DEFAULT_SK = 'STYLEDEFAULT';
