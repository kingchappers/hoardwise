import type { Router } from './router';
import { registerCoreRoutes } from './routes';
import { registerDocsRoutes } from './docs';
import { createPushSubscription, deletePushSubscription } from './push';
import { authorizeOauthClient, getOauthClient } from './oauthConsent';
import { createAccessToken, listAccessTokens, revokeAccessToken } from './tokens';

export function registerApiRoutes(router: Router): void {
  registerCoreRoutes(router);
  registerDocsRoutes(router);
  router.post('/api/push/subscriptions', createPushSubscription);
  router.delete('/api/push/subscriptions', deletePushSubscription);
  router.post('/api/tokens', createAccessToken);
  router.get('/api/tokens', listAccessTokens);
  router.delete('/api/tokens/{tokenId}', revokeAccessToken);
  router.get('/api/oauth/client', getOauthClient);
  router.post('/api/oauth/authorize', authorizeOauthClient);
}
