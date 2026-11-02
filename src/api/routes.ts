import type { Router } from './router';
import { getCategories, createCategory, updateCategory, deleteCategory } from './categories';
import { getTransactions, createTransaction, deleteTransaction, updateTransaction } from './transactions';
import { getTargets, upsertTarget, deleteTarget } from './targets';
import { getExpectedIncome, putExpectedIncome, deleteExpectedIncome } from './expectedIncome';
import { getPots, putPot } from './pots';
import { archivePot, unarchivePot } from './potArchive';
import { getTransactionsRange } from './transactionsRange';
import { reassignCategory } from './reassign';
import {
  getRecurring, createRecurring, updateRecurring, deleteRecurring, setRecurringHandled,
} from './recurring';
import { getAccounts, createAccount, updateAccount, deleteAccount, addBalance } from './accounts';
import { getTrash, restoreFromTrash } from './trash';

// Everything the API serves except push subscriptions, which need Node's crypto and so stay with the Lambda entry point.
export function registerCoreRoutes(router: Router): void {
  router.get('/api/categories', getCategories);
  router.post('/api/categories/{categoryId}/reassign', reassignCategory);
  router.post('/api/categories', createCategory);
  router.put('/api/categories/{categoryId}', updateCategory);
  router.delete('/api/categories/{categoryId}', deleteCategory);
  router.get('/api/transactions', getTransactions);
  router.post('/api/transactions', createTransaction);
  router.delete('/api/transactions/{yearMonth}/{transactionId}', deleteTransaction);
  router.put('/api/transactions/{yearMonth}/{transactionId}', updateTransaction);
  router.get('/api/transactions/range', getTransactionsRange);
  router.get('/api/targets', getTargets);
  router.put('/api/targets/{categoryId}', upsertTarget);
  router.delete('/api/targets/{categoryId}', deleteTarget);
  router.get('/api/expected-income', getExpectedIncome);
  router.put('/api/expected-income', putExpectedIncome);
  router.delete('/api/expected-income', deleteExpectedIncome);
  router.get('/api/pots', getPots);
  router.put('/api/pots/{categoryId}', putPot);
  router.post('/api/pots/{categoryId}/archive', archivePot);
  router.post('/api/pots/{categoryId}/unarchive', unarchivePot);
  router.get('/api/recurring', getRecurring);
  router.post('/api/recurring', createRecurring);
  router.put('/api/recurring/{recurringId}', updateRecurring);
  router.delete('/api/recurring/{recurringId}', deleteRecurring);
  router.post('/api/recurring/{recurringId}/handled', setRecurringHandled);
  router.get('/api/accounts', getAccounts);
  router.post('/api/accounts', createAccount);
  router.put('/api/accounts/{accountId}', updateAccount);
  router.delete('/api/accounts/{accountId}', deleteAccount);
  router.post('/api/accounts/{accountId}/balances', addBalance);
  router.get('/api/trash', getTrash);
  router.post('/api/trash/restore', restoreFromTrash);
}
