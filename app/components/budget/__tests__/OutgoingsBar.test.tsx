import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { OutgoingsBar, type OutgoingsBarProps } from '../OutgoingsBar';

const october: OutgoingsBarProps = {
  incomeLabel: 'Income',
  incomePence: 488129,
  incomeNoun: 'your income',
  partsLabel: 'Where it went',
  parts: [
    { label: 'Expenses', pence: 372784 },
    { label: 'Put into pots', pence: 141479 },
  ],
  totalLabel: 'Spent + put away',
  secondary: {
    label: 'Actually spent',
    pence: 420940,
    explainer: "Money that left your accounts: your expenses plus spending paid out of pots. Pot spending comes out of what you put away earlier, so it isn't added to 'Spent + put away'.",
  },
};

function renderBar(props: Partial<OutgoingsBarProps> = {}) {
  return render(<MantineProvider><OutgoingsBar {...october} {...props} /></MantineProvider>);
}

describe('OutgoingsBar', () => {
  it('shows both figures and the explainer', () => {
    renderBar();
    expect(screen.getByText(/£5,142\.63/)).toBeInTheDocument();
    expect(screen.getByText(/£4,209\.40/)).toBeInTheDocument();
    expect(screen.getByText(/£261\.34 more than your income/)).toBeInTheDocument();
    expect(screen.getByText(/paid out of pots/)).toBeInTheDocument();
  });

  it('shows the income figure under the income bar', () => {
    renderBar();
    expect(screen.getByText('£4,881.29')).toBeInTheDocument();
  });

  it('hides the over/under line when income is zero or unknown', () => {
    const { rerender } = renderBar({ incomePence: null });
    expect(screen.queryByText(/more than|left after pots/)).not.toBeInTheDocument();
    rerender(<MantineProvider><OutgoingsBar {...october} incomePence={0} /></MantineProvider>);
    expect(screen.queryByText(/more than|left after pots/)).not.toBeInTheDocument();
  });

  it('income bar is shorter than outgoings bar when over income', () => {
    renderBar();
    expect(screen.getByTestId('income-bar')).toHaveStyle({ width: '94.9%' });
    expect(screen.getByTestId('parts-bar')).toHaveStyle({ width: '100%' });
  });

  it('says what is left when income covers the outgoings', () => {
    renderBar({ incomePence: 600000 });
    expect(screen.getByText(/£857\.37 left after pots/)).toBeInTheDocument();
    expect(screen.getByTestId('parts-bar')).toHaveStyle({ width: '85.7%' });
  });

  describe('when take-outs exceed money put in', () => {
    const netTakeOut: Partial<OutgoingsBarProps> = {
      incomePence: 100000,
      parts: [
        { label: 'Expenses', pence: 60000 },
        { label: 'Put into pots', pence: -20000, negativeLabel: 'Taken out of pots' },
      ],
    };

    it('never draws a negative or over-full part', () => {
      renderBar(netTakeOut);
      const widths = Array.from(screen.getByTestId('parts-bar').children).map(
        (child) => parseFloat((child as HTMLElement).style.width),
      );
      expect(widths).toHaveLength(2);
      for (const width of widths) {
        expect(width).toBeGreaterThanOrEqual(0);
        expect(width).toBeLessThanOrEqual(100);
      }
      expect(widths[0] + widths[1]).toBeLessThanOrEqual(100);
    });

    it('names the negative part as money taken out, with a positive amount', () => {
      renderBar(netTakeOut);
      expect(screen.getByText('Taken out of pots £200.00')).toBeInTheDocument();
      expect(screen.queryByText(/Put into pots/)).not.toBeInTheDocument();
    });

    it('leaves the total as the net figure', () => {
      renderBar(netTakeOut);
      expect(screen.getByText('Spent + put away: £400.00')).toBeInTheDocument();
    });
  });
});
