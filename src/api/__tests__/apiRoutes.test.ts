import { describe, it, expect } from 'vitest';
import { createRouter } from '../router';
import { registerApiRoutes } from '../apiRoutes';

describe('registerApiRoutes', () => {
  const router = createRouter();
  registerApiRoutes(router);
  const routes = router.routes();

  it('registers every API route', () => {
    expect(routes).toHaveLength(38);
  });

  it('includes the docs routes', () => {
    expect(routes).toContainEqual({ method: 'GET', template: '/api/openapi.json' });
    expect(routes).toContainEqual({ method: 'GET', template: '/api/docs/agents' });
  });

  it('includes the push and token routes', () => {
    expect(routes).toContainEqual({ method: 'DELETE', template: '/api/tokens/{tokenId}' });
    expect(routes).toContainEqual({ method: 'POST', template: '/api/push/subscriptions' });
  });
});
