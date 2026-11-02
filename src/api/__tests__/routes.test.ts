import { describe, expect, it } from 'vitest';
import type { Router } from '../router';
import { registerCoreRoutes } from '../routes';

function recordingRouter(): { router: Router; routes: string[] } {
  const routes: string[] = [];
  const add = (method: string) => (path: string): void => { routes.push(`${method} ${path}`); };
  const router: Router = {
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    dispatch: async () => { throw new Error('not used'); },
    routes: () => [],
  };
  return { router, routes };
}

describe('registerCoreRoutes', () => {
  it('registers every API route except push, in a stable order', () => {
    const { router, routes } = recordingRouter();
    registerCoreRoutes(router);
    expect(routes).toEqual([
      'GET /api/categories',
      'POST /api/categories/{categoryId}/reassign',
      'POST /api/categories',
      'PUT /api/categories/{categoryId}',
      'DELETE /api/categories/{categoryId}',
      'GET /api/transactions',
      'POST /api/transactions',
      'DELETE /api/transactions/{yearMonth}/{transactionId}',
      'PUT /api/transactions/{yearMonth}/{transactionId}',
      'GET /api/transactions/range',
      'GET /api/targets',
      'PUT /api/targets/{categoryId}',
      'DELETE /api/targets/{categoryId}',
      'GET /api/expected-income',
      'PUT /api/expected-income',
      'DELETE /api/expected-income',
      'GET /api/pots',
      'PUT /api/pots/{categoryId}',
      'POST /api/pots/{categoryId}/archive',
      'POST /api/pots/{categoryId}/unarchive',
      'GET /api/recurring',
      'POST /api/recurring',
      'PUT /api/recurring/{recurringId}',
      'DELETE /api/recurring/{recurringId}',
      'POST /api/recurring/{recurringId}/handled',
      'GET /api/accounts',
      'POST /api/accounts',
      'PUT /api/accounts/{accountId}',
      'DELETE /api/accounts/{accountId}',
      'POST /api/accounts/{accountId}/balances',
      'GET /api/trash',
      'POST /api/trash/restore',
    ]);
  });

  it('leaves the push routes to the Lambda entry point', () => {
    const { router, routes } = recordingRouter();
    registerCoreRoutes(router);
    expect(routes.filter(route => route.includes('/api/push'))).toEqual([]);
  });
});
