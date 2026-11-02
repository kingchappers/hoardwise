export type ParseResult =
  | { ok: true; pence: number }
  | { ok: false; message: string };

export const MAX_AMOUNT_PENCE = 1_000_000_000;

export function parsePounds(input: string): ParseResult {
  const cleaned = input.trim().replace(/^£/, '').replace(/,/g, '').trim();

  if (cleaned === '') {
    return { ok: false, message: 'Enter an amount' };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    if (/^\d+\.\d{3,}$/.test(cleaned)) {
      return { ok: false, message: 'Use at most two decimal places' };
    }
    return { ok: false, message: 'Enter a valid amount' };
  }

  const [whole, fraction = ''] = cleaned.split('.');
  const pence = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (!Number.isSafeInteger(pence) || pence > MAX_AMOUNT_PENCE) {
    return { ok: false, message: 'Amount is too large' };
  }

  if (pence <= 0) {
    return { ok: false, message: 'Amount must be greater than zero' };
  }

  return { ok: true, pence };
}

export function parseOptionalPounds(
  text: string,
): { ok: true; pence: number | null } | { ok: false; message: string } {
  if (text.trim() === '') return { ok: true, pence: null };
  const parsed = parsePounds(text);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  if (parsed.pence <= 0) return { ok: false, message: 'Enter an amount greater than zero' };
  return { ok: true, pence: parsed.pence };
}

// A balance, unlike a transaction amount, is allowed to be zero (an account
// paid off or closed) or negative (an overdrawn current account). It accepts
// an optional leading '-' for that reason; everything else matches parsePounds.
export function parseBalance(input: string): ParseResult {
  const trimmed = input.trim();
  const negative = trimmed.startsWith('-');
  const cleaned = (negative ? trimmed.slice(1) : trimmed).replace(/^£/, '').replace(/,/g, '').trim();

  if (cleaned === '') {
    return { ok: false, message: 'Enter an amount' };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    if (/^\d+\.\d{3,}$/.test(cleaned)) {
      return { ok: false, message: 'Use at most two decimal places' };
    }
    return { ok: false, message: 'Enter a valid amount' };
  }

  const [whole, fraction = ''] = cleaned.split('.');
  const magnitude = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  const pence = negative ? -magnitude : magnitude;

  if (!Number.isSafeInteger(pence) || Math.abs(pence) > MAX_AMOUNT_PENCE) {
    return { ok: false, message: 'Amount is too large' };
  }

  return { ok: true, pence };
}

const formatter = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
});

export function formatPence(pence: number): string {
  return formatter.format(pence / 100);
}

export function formatPencePlain(pence: number): string {
  return (pence / 100).toFixed(2);
}
