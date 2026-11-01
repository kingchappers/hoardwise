import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { createRouter } from './src/api/router';
import { initStore } from './src/store';
import { initAuth } from './src/auth';
import { SECURITY_HEADERS } from './src/api/constants';
import { err } from './src/api/http';
import type { ApiResponse } from './src/api/types';
import { registerApiRoutes } from './src/api/apiRoutes';
import { createTokenRouter } from './src/api/tokenRouter';
import { authenticateToken, presentsAccessToken, tokenAccessRejection } from './src/auth/tokenAuth';
import { touchToken } from './src/auth/tokens';
import { createFailureLimiter } from './src/auth/failureLimiter';
import { handleMcpRequest } from './src/mcp/handler';
import { MCP_TOOLS } from './src/mcp/tools';
import { resolvePublicOrigin } from './src/oauth/config';
import { handleOauthPublic, isOauthPublicPath } from './src/oauth/routes';

const router = createRouter();
registerApiRoutes(router);

const tokenRouter = createTokenRouter();

const INTERNAL_ERROR = JSON.stringify({ error: 'Internal server error' });

// Exact in the container (one process); per instance on AWS, where API Gateway's throttling is the main limit.
const tokenFailures = createFailureLimiter();

// Unset or invalid APP_ORIGIN disables OAuth. Registrations: 60 per address per hour, exact in the container and per
// instance on AWS, where the route's own throttle backs it.
const discoveryLimiter = createFailureLimiter({ maxFailures: 60, windowSeconds: 60, blockSeconds: 60 });
// Token requests: 30 failures per address per 10 minutes (refresh grants are exempt). Revoke counts every request at the same rate.
const tokenLimiter = createFailureLimiter({ maxFailures: 30, windowSeconds: 600, blockSeconds: 600 });
const revokeLimiter = createFailureLimiter({ maxFailures: 30, windowSeconds: 600, blockSeconds: 600 });
const registrationLimiter = createFailureLimiter({ maxFailures: 60, windowSeconds: 3600, blockSeconds: 3600 });

function tooManyRequests(): ApiResponse {
  const response = err(429, 'Too many requests');
  return { ...response, headers: { ...response.headers, 'Retry-After': '60' } };
}

// Runs ahead of the configured auth provider: a token is the only credential such a request uses, so neither the
// session cookie nor its Origin check applies, and the provider's public /api/auth routes are never reached.
async function handleTokenRequest(event: APIGatewayProxyEventV2): Promise<ApiResponse> {
  const sourceIp = event.requestContext.http.sourceIp;
  if (tokenFailures.isBlocked(sourceIp)) return tooManyRequests();

  const store = await initStore();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const result = await authenticateToken(event, store, nowSeconds);
  if ('rejection' in result) {
    tokenFailures.recordFailure(sourceIp);
    if (tokenFailures.isBlocked(sourceIp)) return tooManyRequests();
    return result.rejection;
  }

  const refusal = tokenAccessRejection(result.scope, event.requestContext.http.method, event.rawPath);
  if (refusal) {
    console.warn('Token access refused:', event.requestContext.routeKey, refusal.reason);
    return refusal.rejection;
  }

  try {
    await touchToken(store, result.stored, nowSeconds);
  } catch (error) {
    console.warn('Token last-used update failed:', error instanceof Error ? error.name : 'Error');
  }
  return tokenRouter.dispatch(event, result.userId);
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  console.log('Request:', {
    // Log the templated route, not the raw path — path segments can carry
    // resource IDs that the spec's Logging section says must never be logged.
    route: event.requestContext.routeKey,
    method: event.requestContext.http.method,
    sourceIp: event.requestContext.http.sourceIp,
  });

  // A failure inside a handler is the server's, not an authentication failure, so it is kept apart
  // from the 401s below and answered with a generic body; the detail goes to the logs only.
  try {
    if (event.rawPath === '/mcp') {
      return await handleMcpRequest(event, MCP_TOOLS, { store: await initStore(), now: new Date(), tokenFailures, oauthOrigin: resolvePublicOrigin() });
    }
    // Public OAuth routes: never through the auth provider, a session or a JWT.
    if (isOauthPublicPath(event.rawPath)) {
      const oauthResponse = await handleOauthPublic(event, {
        getStore: initStore,
        origin: resolvePublicOrigin(),
        limiter: registrationLimiter,
        discoveryLimiter,
        tokenLimiter,
        revokeLimiter,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      if (oauthResponse) return oauthResponse;
    }
    if (presentsAccessToken(event)) return await handleTokenRequest(event);

    const auth = await initAuth();
    const publicResponse = await auth.handlePublic?.(event);
    if (publicResponse) return publicResponse;

    const result = await auth.authenticate(event);
    if ('rejection' in result) return result.rejection;

    await initStore();
    return await router.dispatch(event, result.userId);
  } catch (error) {
    console.error(`Unhandled error in ${event.requestContext.routeKey}:`, error instanceof Error ? error.message : String(error));
    return { statusCode: 500, headers: SECURITY_HEADERS, body: INTERNAL_ERROR };
  }
};
