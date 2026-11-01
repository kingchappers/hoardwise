import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { SECURITY_HEADERS } from './constants';
import type { ApiResponse } from './types';

export function ok(body: object): ApiResponse {
  return { statusCode: 200, headers: SECURITY_HEADERS, body: JSON.stringify(body) };
}

export function err(status: number, message: string, extra: object = {}): ApiResponse {
  return { statusCode: status, headers: SECURITY_HEADERS, body: JSON.stringify({ error: message, ...extra }) };
}

export function parseJsonObject(event: APIGatewayProxyEventV2): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.body || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function noStore(response: ApiResponse): ApiResponse {
  return { ...response, headers: { ...response.headers, 'Cache-Control': 'no-store' } };
}
