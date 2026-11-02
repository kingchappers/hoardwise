import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../app.css'), 'utf8');

function block(selectorStart: string): string {
  const start = css.indexOf(selectorStart);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(open + 1, index);
  }
  return '';
}

describe('touch targets', () => {
  const coarse = block('@media (pointer: coarse)');

  it('gives icon buttons a 44px target on touch screens', () => {
    expect(coarse).toMatch(/\.mantine-ActionIcon-root[\s\S]*min-width:\s*44px/);
    expect(coarse).toMatch(/\.mantine-ActionIcon-root[\s\S]*min-height:\s*44px/);
  });

  it('gives compact buttons a 44px target on touch screens too', () => {
    expect(coarse).toMatch(/\.mantine-Button-root\[data-size\^='compact'\]/);
  });

  it('only applies to touch, so mouse layouts keep their density', () => {
    expect(css).toMatch(/@media \(pointer: coarse\)/);
    expect(coarse).not.toMatch(/max-width/);
  });

  it('keeps the tab bar labels at 12px at larger text sizes so all five tabs fit', () => {
    const rule = block("html[data-text-size='large'] .tab-label");
    expect(rule).toMatch(/font-size:\s*12px/);
  });

  it('shows error text at 14px, not Mantine\'s 12px', () => {
    expect(block('.mantine-InputWrapper-error')).toMatch(/font-size:\s*0\.875rem/);
  });

  it('moves toasts to the top while a sheet is open, so they never cover its buttons', () => {
    expect(css).toMatch(/body:has\(\[role='dialog'\]\) \.mantine-Notifications-root/);
  });

  it('hides only the app name from a phone header at larger text sizes', () => {
    expect(block("html[data-text-size='largest'] .app-wordmark")).toMatch(/display:\s*none/);
  });
});
