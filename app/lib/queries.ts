import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAuth } from '~/lib/auth';
import { useProtectedApi } from '~/hooks/useProtectedApi';
import { ApiError } from '~/lib/apiError';
import { expectedIncome } from '../../src/shared/monthFigures';
import { createApi, type AccessTokenInput, type RecurringInput, type TransactionInput } from './api';
import { clearPendingEntry, OFFLINE_QUEUE_KEY, pendingRowsForMonth, type PendingMap } from './pendingEntries';
import type { TrashEntityType, TrashRef } from './trash';
import type { AccessToken, Account, Category, CategoryGroup, CategoryTarget, PotSettingsInput, Recurring, TargetPeriod, Transaction } from './types';

export const queryKeys = {
  categories: ['categories'] as const,
  targets: ['targets'] as const,
  expectedIncome: ['expectedIncome'] as const,
  transactions: (yearMonth: string) => ['transactions', yearMonth] as const,
  transactionsRange: (from: string, to: string) => ['transactionsRange', from, to] as const,
  recurring: ['recurring'] as const,
  pots: (asOf: string) => ['pots', asOf] as const,
  offlineQueue: OFFLINE_QUEUE_KEY,
  accounts: ['accounts'] as const,
  trash: ['trash'] as const,
  accessTokens: ['accessTokens'] as const,
  apiSpec: ['apiSpec'] as const,
};

// What is already loaded, for text that should not wait on a request.
export function getCachedBudgets(qc: QueryClient): CategoryTarget[] {
  return qc.getQueryData<CategoryTarget[]>(queryKeys.targets) ?? [];
}

export function getCachedMonth(qc: QueryClient, yearMonth: string): Transaction[] {
  return qc.getQueryData<Transaction[]>(queryKeys.transactions(yearMonth)) ?? [];
}

export function useApi() {
  const { request } = useProtectedApi();
  return useMemo(() => createApi(request), [request]);
}

// Every endpoint needs a bearer token, so a query fired before Auth0 has finished
// restoring the session rejects and parks in an error state that nothing retries.
function useAuthReady() {
  return useAuth().isAuthenticated;
}

export function useCategories() {
  const api = useApi();
  const enabled = useAuthReady();
  return useQuery({
    queryKey: queryKeys.categories,
    queryFn: () => api.getCategories(),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useApiSpec() {
  const api = useApi();
  const enabled = useAuthReady();
  return useQuery({
    queryKey: queryKeys.apiSpec,
    queryFn: () => api.getApiSpec(),
    staleTime: 60 * 60_000,
    refetchOnWindowFocus: false,
    enabled,
  });
}

export function useTargets() {
  const api = useApi();
  const enabled = useAuthReady();
  return useQuery({
    queryKey: queryKeys.targets,
    queryFn: () => api.getTargets(),
    enabled,
  });
}

export function useExpectedIncome() {
  const api = useApi();
  const enabled = useAuthReady();
  return useQuery({
    queryKey: queryKeys.expectedIncome,
    queryFn: async () => ({ amount: await api.getExpectedIncome() }),
    enabled,
  });
}

// Unknown (null) until the saved override has loaded, or if it failed to load:
// showing the history figure first could flash a number the user has overridden.
export function useExpectedIncomeValue(regular: number | null): number | null {
  const { data, isPending, isError } = useExpectedIncome();
  if (isPending || isError) return null;
  return expectedIncome(data?.amount ?? null, regular);
}

export function useSetExpectedIncome() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amount: number) => api.setExpectedIncome(amount),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.expectedIncome }),
  });
}

export function useClearExpectedIncome() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.clearExpectedIncome(),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.expectedIncome }),
  });
}

// Merges any still-pending (unsent or queued-offline) entries for this month
// on top of whatever the server returned, so a pending row survives any
// refetch instead of depending on a one-off cache write that a later
// invalidation would silently erase.
function useTransactionsOverlay(yearMonth: string, serverRows: Transaction[] | undefined): Transaction[] | undefined {
  const { data: pendingMap = {} } = useQuery<PendingMap>({
    queryKey: OFFLINE_QUEUE_KEY,
    queryFn: () => ({}),
    initialData: {},
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return useMemo(() => {
    const pendingRows = pendingRowsForMonth(pendingMap, yearMonth);
    if (pendingRows.length === 0) return serverRows;
    const knownIds = new Set((serverRows ?? []).map(t => t.transactionId));
    const extra = pendingRows.filter(row => !knownIds.has(row.transactionId));
    if (extra.length === 0) return serverRows;
    return [...(serverRows ?? []), ...extra];
  }, [pendingMap, yearMonth, serverRows]);
}

export function useTransactions(yearMonth: string, enabled: boolean = true) {
  const api = useApi();
  const authReady = useAuthReady();
  const query = useQuery({
    queryKey: queryKeys.transactions(yearMonth),
    queryFn: () => api.getTransactions(yearMonth),
    enabled: authReady && enabled,
  });
  const data = useTransactionsOverlay(yearMonth, query.data);
  return { ...query, data };
}

export function useTransactionsRange(from: string, to: string, enabled: boolean = true) {
  const api = useApi();
  const authReady = useAuthReady();
  return useQuery({
    queryKey: queryKeys.transactionsRange(from, to),
    queryFn: () => api.getTransactionsRange(from, to),
    enabled: authReady && enabled,
  });
}

export function useCreateTransaction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<Transaction, Error, TransactionInput>({
    mutationFn: (input) => api.createTransaction(input),
    // The default 'online' mode PAUSES a mutation while the browser reports
    // itself offline rather than letting it fail — so useSaveWithUndo's
    // rejection handler (the thing that queues the entry) would never run,
    // and a create attempted with no signal would just sit in memory and be
    // lost when the app closes. 'always' lets it fail immediately instead.
    networkMode: 'always',
    onSettled: async (created, _error, input) => {
      if (!created) {
        // A rejected mutation: fire the invalidation without awaiting it.
        // useSaveWithUndo's own rejection handler is what decides whether to
        // queue this entry, and TanStack awaits onSettled before mutateAsync
        // rejects — awaiting the invalidation here (plus its own retry) would
        // delay that decision, leaving an entry that should already be
        // safely in IndexedDB sitting only in memory for longer.
        qc.invalidateQueries({ queryKey: queryKeys.transactions(input.date.slice(0, 7)) });
        qc.invalidateQueries({ queryKey: ['pots'] });
        qc.invalidateQueries({ queryKey: ['transactionsRange'] });
        return;
      }
      // Wait for the refetch before clearing the pending overlay row for a
      // successful create, so the real server row is already in place and
      // nothing blinks out in between.
      await qc.invalidateQueries({ queryKey: queryKeys.transactions(input.date.slice(0, 7)) });
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: ['transactionsRange'] });
      if (input.transactionId) clearPendingEntry(qc, input.transactionId);
    },
  });
}

export function useUpdateTransaction(yearMonth: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { transactionId: string; input: TransactionInput }) =>
      api.updateTransaction(yearMonth, vars.transactionId, vars.input),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: queryKeys.transactions(yearMonth) });
      if (updated.yearMonth !== yearMonth) {
        qc.invalidateQueries({ queryKey: queryKeys.transactions(updated.yearMonth) });
      }
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: ['transactionsRange'] });
    },
  });
}

interface LinkTransactionVars {
  transaction: Transaction;
  recurringId: string;
}

function toInput(transaction: Transaction): TransactionInput {
  const { amount, type, categoryId, description, date } = transaction;
  return { amount, type, categoryId, description, date };
}

// Records that a hand-typed transaction is the payment of a recurring bill.
export function useLinkTransaction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<Transaction, Error, LinkTransactionVars, { previous: Transaction[] | undefined }>({
    mutationFn: ({ transaction, recurringId }) =>
      api.updateTransaction(transaction.yearMonth, transaction.transactionId, { ...toInput(transaction), recurringId }),
    onMutate: async ({ transaction, recurringId }) => {
      const key = queryKeys.transactions(transaction.yearMonth);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<Transaction[]>(key);
      qc.setQueryData<Transaction[]>(key, rows => rows?.map(row =>
        (row.transactionId === transaction.transactionId ? { ...row, recurringId } : row)));
      return { previous };
    },
    onError: (_error, { transaction }, context) => {
      qc.setQueryData(queryKeys.transactions(transaction.yearMonth), context?.previous);
    },
    onSettled: (_data, _error, { transaction }) => {
      qc.invalidateQueries({ queryKey: queryKeys.transactions(transaction.yearMonth) });
    },
  });
}

interface RemovedRow<T> {
  removed: T | undefined;
}

// Hides a row the instant a delete starts, so it never lingers on screen
// while the request is in flight. Returns the removed row so a failed
// delete can put exactly that row back without clobbering other changes.
async function removeRow<T>(qc: QueryClient, queryKey: QueryKey, matches: (row: T) => boolean): Promise<RemovedRow<T>> {
  await qc.cancelQueries({ queryKey });
  const removed = qc.getQueryData<T[]>(queryKey)?.find(matches);
  qc.setQueryData<T[]>(queryKey, rows => rows?.filter(row => !matches(row)));
  return { removed };
}

function restoreRow<T>(qc: QueryClient, queryKey: QueryKey, context: RemovedRow<T> | undefined, matches: (row: T) => boolean): void {
  const removed = context?.removed;
  if (removed === undefined) return;
  qc.setQueryData<T[]>(queryKey, rows => {
    if (!rows || rows.some(matches)) return rows;
    return [...rows, removed];
  });
}

interface DeleteTransactionVars {
  transactionId: string;
  yearMonth: string;
}

export function useDeleteTransaction() {
  const api = useApi();
  const qc = useQueryClient();
  const matches = (vars: DeleteTransactionVars) => (row: Transaction): boolean => row.transactionId === vars.transactionId;
  return useMutation<void, Error, DeleteTransactionVars, RemovedRow<Transaction>>({
    mutationFn: (vars) => api.deleteTransaction(vars.yearMonth, vars.transactionId),
    onMutate: (vars) => removeRow(qc, queryKeys.transactions(vars.yearMonth), matches(vars)),
    onError: (_error, vars, context) => restoreRow(qc, queryKeys.transactions(vars.yearMonth), context, matches(vars)),
    onSettled: (_data, _error, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.transactions(vars.yearMonth) });
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: ['transactionsRange'] });
      qc.invalidateQueries({ queryKey: queryKeys.trash });
    },
  });
}

export function useSetTarget() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { categoryId: string; targetAmount: number; period: TargetPeriod }) =>
      api.setTarget(vars.categoryId, vars.targetAmount, vars.period),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.targets }),
  });
}

export function useDeleteTarget() {
  const api = useApi();
  const qc = useQueryClient();
  const matches = (categoryId: string) => (row: CategoryTarget): boolean => row.categoryId === categoryId;
  return useMutation<void, Error, string, RemovedRow<CategoryTarget>>({
    mutationFn: (categoryId) => api.deleteTarget(categoryId),
    onMutate: (categoryId) => removeRow(qc, queryKeys.targets, matches(categoryId)),
    onError: (_error, categoryId, context) => restoreRow(qc, queryKeys.targets, context, matches(categoryId)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.targets });
      qc.invalidateQueries({ queryKey: queryKeys.trash });
    },
  });
}

export function useCreateCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; type: Category['type']; icon: string; group?: CategoryGroup }) => api.createCategory(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.categories });
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: ['transactionsRange'] });
    },
  });
}

export function useReassignCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { categoryId: string; toCategoryId: string }) =>
      api.reassignCategory(vars.categoryId, vars.toCategoryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.recurring });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: ['transactionsRange'] });
    },
  });
}

export function useUpdateCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { categoryId: string; name: string }) => api.updateCategory(vars.categoryId, vars.name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.categories });
      qc.invalidateQueries({ queryKey: queryKeys.targets });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: queryKeys.recurring });
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: ['transactionsRange'] });
    },
  });
}

export function useDeleteCategory() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (categoryId: string) => api.deleteCategory(categoryId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.categories });
      qc.invalidateQueries({ queryKey: queryKeys.targets });
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: queryKeys.recurring });
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: ['transactionsRange'] });
    },
  });
}

export function usePots(asOf: string, enabled: boolean = true) {
  const api = useApi();
  const authReady = useAuthReady();
  return useQuery({
    queryKey: queryKeys.pots(asOf),
    queryFn: () => api.getPots(asOf),
    enabled: authReady && enabled,
  });
}

export function useSavePot() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { categoryId: string; input: PotSettingsInput }) =>
      api.savePot(vars.categoryId, vars.input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: ['transactionsRange'] });
    },
  });
}

export function useArchivePot() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<{ cancelledRecurring: number }, Error, { categoryId: string; month: string }>({
    mutationFn: (vars) => api.archivePot(vars.categoryId, vars.month),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: queryKeys.categories });
      qc.invalidateQueries({ queryKey: queryKeys.recurring });
      qc.invalidateQueries({ queryKey: queryKeys.trash });
    },
  });
}

export function useUnarchivePot() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (categoryId) => api.unarchivePot(categoryId),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['pots'] });
      qc.invalidateQueries({ queryKey: queryKeys.categories });
    },
  });
}

export function useRecurring() {
  const api = useApi();
  const enabled = useAuthReady();
  return useQuery({
    queryKey: queryKeys.recurring,
    queryFn: () => api.getRecurring(),
    enabled,
  });
}

export function useCreateRecurring() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecurringInput) => api.createRecurring(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.recurring }),
  });
}

export function useUpdateRecurring() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { recurringId: string; input: RecurringInput }) =>
      api.updateRecurring(vars.recurringId, vars.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.recurring }),
  });
}

export function useDeleteRecurring() {
  const api = useApi();
  const qc = useQueryClient();
  const matches = (recurringId: string) => (row: Recurring): boolean => row.recurringId === recurringId;
  return useMutation<void, Error, string, RemovedRow<Recurring>>({
    mutationFn: (recurringId) => api.deleteRecurring(recurringId),
    onMutate: (recurringId) => removeRow(qc, queryKeys.recurring, matches(recurringId)),
    onError: (_error, recurringId, context) => restoreRow(qc, queryKeys.recurring, context, matches(recurringId)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.recurring });
      qc.invalidateQueries({ queryKey: queryKeys.trash });
    },
  });
}

interface SetHandledVars {
  recurringId: string;
  period: string | null;
}

function withHandledPeriod(rows: Recurring[] | undefined, recurringId: string, period: string | null): Recurring[] | undefined {
  return rows?.map(row => (row.recurringId === recurringId ? { ...row, handledPeriod: period } : row));
}

export function useSetRecurringHandled() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<Recurring, Error, SetHandledVars, { previousPeriod: string | null }>({
    mutationFn: (vars) => api.setRecurringHandled(vars.recurringId, vars.period),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: queryKeys.recurring });
      const rows = qc.getQueryData<Recurring[]>(queryKeys.recurring);
      const previousPeriod = rows?.find(row => row.recurringId === vars.recurringId)?.handledPeriod ?? null;
      qc.setQueryData<Recurring[]>(queryKeys.recurring, current => withHandledPeriod(current, vars.recurringId, vars.period));
      return { previousPeriod };
    },
    onError: (_error, vars, context) => {
      if (!context) return;
      qc.setQueryData<Recurring[]>(queryKeys.recurring, current => withHandledPeriod(current, vars.recurringId, context.previousPeriod));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.recurring });
    },
  });
}

export function useAccounts() {
  const api = useApi();
  const enabled = useAuthReady();
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => api.getAccounts(),
    enabled,
  });
}

export function useCreateAccount() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; kind: Account['kind']; type: Account['type'] }) => api.createAccount(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

export function useUpdateAccount() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { accountId: string; input: { name: string; type: Account['type'] } }) =>
      api.updateAccount(vars.accountId, vars.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

export function useDeleteAccount() {
  const api = useApi();
  const qc = useQueryClient();
  const matches = (accountId: string) => (row: Account): boolean => row.accountId === accountId;
  return useMutation<void, Error, string, RemovedRow<Account>>({
    mutationFn: (accountId) => api.deleteAccount(accountId),
    onMutate: (accountId) => removeRow(qc, queryKeys.accounts, matches(accountId)),
    onError: (_error, accountId, context) => restoreRow(qc, queryKeys.accounts, context, matches(accountId)),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: queryKeys.accounts });
      qc.invalidateQueries({ queryKey: queryKeys.trash });
    },
  });
}

export function useAddBalance() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { accountId: string; input: { date: string; pence: number } }) =>
      api.addBalance(vars.accountId, vars.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.accounts }),
  });
}

export function useTrash() {
  const api = useApi();
  const enabled = useAuthReady();
  return useQuery({
    queryKey: queryKeys.trash,
    queryFn: () => api.getTrash(),
    enabled,
  });
}

const RESTORED_LISTS: Record<TrashEntityType, QueryKey[]> = {
  TRANSACTION: [['transactions'], ['pots'], ['transactionsRange']],
  TARGET: [queryKeys.targets],
  RECURRING: [queryKeys.recurring],
  ACCOUNT: [queryKeys.accounts],
};

export function useRestoreFromTrash() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, Error, TrashRef>({
    mutationFn: (ref) => api.restoreFromTrash(ref.entityType, ref.id),
    onSettled: (_data, _error, ref) => {
      qc.invalidateQueries({ queryKey: queryKeys.trash });
      RESTORED_LISTS[ref.entityType].forEach(queryKey => qc.invalidateQueries({ queryKey }));
    },
  });
}

export function useAccessTokens() {
  const api = useApi();
  const enabled = useAuthReady();
  return useQuery({
    queryKey: queryKeys.accessTokens,
    queryFn: () => api.listAccessTokens(),
    enabled,
  });
}

// The new token string only travels in the mutation result to the caller; it is never written to the query cache, and gcTime 0 drops the mutation (result and password) once the component unmounts.
export function useCreateAccessToken() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<{ token: string; record: AccessToken }, Error, AccessTokenInput>({
    mutationFn: (input) => api.createAccessToken(input),
    gcTime: 0,
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.accessTokens }),
  });
}

export function useRevokeAccessToken() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (tokenId) => {
      try {
        await api.revokeAccessToken(tokenId);
      } catch (error) {
        // 404: already revoked elsewhere or purged after expiry. The token is gone either way.
        if (error instanceof ApiError && error.status === 404) return;
        throw error;
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.accessTokens }),
  });
}
