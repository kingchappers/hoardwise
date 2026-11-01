export type TransactionType = 'EXPENSE' | 'INCOME' | 'SET_ASIDE' | 'TAKE_OUT';
export type CategoryType = 'EXPENSE' | 'INCOME' | 'POT';
export type CategoryGroup = 'BILLS' | 'SINKING_FUNDS' | 'EVERYDAY' | 'SAVING_INVESTMENT';
export type TargetPeriod = 'MONTHLY' | 'WEEKLY';

export interface Category {
  categoryId: string;
  name: string;
  type: CategoryType;
  icon: string;
  group?: CategoryGroup;
  isDefault: boolean;
  createdAt: string;
  archived?: boolean;
}

export interface Transaction {
  transactionId: string;
  yearMonth: string;
  amount: number;
  type: TransactionType;
  categoryId: string;
  description: string;
  date: string;
  createdAt: string;
  recurringId?: string;
}

export interface CategoryTarget {
  categoryId: string;
  targetAmount: number;
  period: TargetPeriod;
  updatedAt: string;
}

export type RecurringFrequency = 'WEEKLY' | 'FOUR_WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

export interface Recurring {
  recurringId: string;
  type: TransactionType;
  categoryId: string;
  amount: number;
  description: string;
  dayOfMonth: number;
  // A missing frequency means monthly, as for items saved before schedules existed.
  frequency?: RecurringFrequency;
  anchorDate?: string | null;
  leadDays: number;
  // YYYY-MM for monthly items, YYYY-MM-DD for the rest.
  handledPeriod: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PotMonth {
  yearMonth: string; opening: number; setAside: number; autoAdded: number;
  takeOut: number; spent: number; closing: number;
}

export interface PotSummary {
  categoryId: string;
  monthlyAmount: number | null;
  goalAmount: number | null;
  autoAmountNow: number;
  archivedAt?: string | null;
  balance: number;
  thisMonth: { setAside: number; autoAdded: number; takeOut: number; spent: number };
  months: PotMonth[];
}

export interface PotSettingsInput {
  monthlyAmount: number | null;
  goalAmount: number | null;
  autoContribute: boolean;
  month: string;
}

export type AccountKind = 'ASSET' | 'LIABILITY';
export type AccountType = 'CASH' | 'SAVINGS' | 'INVESTMENT' | 'CREDIT_CARD' | 'LOAN';

export interface BalanceEntry {
  date: string;
  pence: number;
}

export interface Account {
  accountId: string;
  name: string;
  kind: AccountKind;
  type: AccountType;
  balances: BalanceEntry[];
  createdAt: string;
}

export type AccessTokenScope = 'read' | 'write';
export type AccessTokenExpiryDays = 90 | 180 | 365 | 730 | null;

export interface AccessToken {
  tokenId: string;
  name: string;
  scope: AccessTokenScope;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  prefix: string;
  kind?: 'oauth';
}
