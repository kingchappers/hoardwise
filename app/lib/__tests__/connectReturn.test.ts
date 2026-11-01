import { beforeEach, describe, expect, it } from 'vitest';
import { clearConnectReturn, isSafeConnectPath, rememberConnectReturn, takeConnectReturn } from '../connectReturn';

const PATH = '/connect?response_type=code&client_id=c&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=s';

beforeEach(() => window.sessionStorage.clear());

describe('connectReturn', () => {
  it('gives back exactly what was remembered, once', () => {
    rememberConnectReturn(PATH, 1000);
    expect(takeConnectReturn(2000)).toBe(PATH);
    expect(takeConnectReturn(2000)).toBeUndefined();
  });

  it('forgets a request after ten minutes', () => {
    rememberConnectReturn(PATH, 1000);
    expect(takeConnectReturn(1000 + 10 * 60 * 1000 + 1)).toBeUndefined();
  });

  it('forgets it when cleared', () => {
    rememberConnectReturn(PATH, 1000);
    clearConnectReturn();
    expect(takeConnectReturn(1001)).toBeUndefined();
  });

  it.each([
    'https://evil.example/connect?x=1',
    '//evil.example/connect',
    '/connect/../settings',
    '/connectfoo',
    '/settings',
    '/connect?x=1\\evil',
    '/connect?x=1#frag',
    '/connect?x=\n1',
    '',
  ])('refuses %j', value => {
    expect(isSafeConnectPath(value)).toBe(false);
    rememberConnectReturn(value, 1000);
    expect(takeConnectReturn(1001)).toBeUndefined();
  });

  it('ignores a tampered stored value', () => {
    window.sessionStorage.setItem('hoardwise.connectReturn', JSON.stringify({ path: 'https://evil.example', at: 1000 }));
    expect(takeConnectReturn(1001)).toBeUndefined();
  });
});
