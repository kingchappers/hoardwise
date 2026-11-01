import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string): string => readFileSync(resolve(__dirname, '../../../infra', file), 'utf8');

describe('AWS wiring for /mcp', () => {
  it('routes every method on /mcp to the API Lambda, which answers 405 for all but POST', () => {
    const tf = read('api-lambda.tf');
    expect(tf).toMatch(
      /resource "aws_apigatewayv2_route" "mcp" \{[^}]*route_key = "ANY \/mcp"[^}]*integrations\/\$\{aws_apigatewayv2_integration\.api_lambda\.id\}/s,
    );
  });

  it('throttles the /mcp route by reference, so the stage depends on the route', () => {
    const tf = read('lambda.tf');
    expect(tf).toMatch(
      /route_settings \{[^}]*route_key\s*=\s*aws_apigatewayv2_route\.mcp\.route_key[^}]*throttling_rate_limit\s*=\s*var\.mcp_throttle_rate_limit\b[^}]*throttling_burst_limit\s*=\s*var\.mcp_throttle_burst_limit\b/s,
    );
  });

  it('defaults the /mcp throttle to 5 per second with a burst of 10', () => {
    const tf = read('variables.tf');
    expect(tf).toMatch(/variable "mcp_throttle_rate_limit" \{[^}]*default\s*=\s*5\b/s);
    expect(tf).toMatch(/variable "mcp_throttle_burst_limit" \{[^}]*default\s*=\s*10\b/s);
  });
});
