export interface PotMonthInput {
  opening: number;
  setAside: number;
  autoAdded: number;
  takeOut: number;
  spent: number;
}

export interface FigureTransaction {
  type: string;
  categoryId: string;
  amount: number;
}

export interface MonthFigures {
  income: number;
  expensesOutsidePots: number;
  putIntoPots: number;
  unfundedPotSpending: number;
  spentAndPutAway: number;
  actuallySpent: number;
  leftAfterPots: number;
}

function unfundedPart(pot: PotMonthInput): number {
  const available = Math.max(
    0,
    pot.opening + pot.setAside + pot.autoAdded - pot.takeOut,
  );
  return Math.min(Math.max(pot.spent - available, 0), pot.spent);
}

export function computeMonthFigures(input: {
  transactions: FigureTransaction[];
  potCategoryIds: ReadonlySet<string>;
  pots: PotMonthInput[];
}): MonthFigures {
  let income = 0;
  let expensesOutsidePots = 0;
  let actuallySpent = 0;
  for (const t of input.transactions) {
    if (t.type === 'INCOME') income += t.amount;
    if (t.type !== 'EXPENSE') continue;
    actuallySpent += t.amount;
    if (!input.potCategoryIds.has(t.categoryId)) expensesOutsidePots += t.amount;
  }

  let putIntoPots = 0;
  let unfundedPotSpending = 0;
  for (const p of input.pots) {
    putIntoPots += p.setAside + p.autoAdded - p.takeOut;
    unfundedPotSpending += unfundedPart(p);
  }

  const spentAndPutAway = expensesOutsidePots + putIntoPots + unfundedPotSpending;
  return {
    income,
    expensesOutsidePots,
    putIntoPots,
    unfundedPotSpending,
    spentAndPutAway,
    actuallySpent,
    leftAfterPots: income - spentAndPutAway,
  };
}

export function outgoingsParts(figures: MonthFigures): { expenses: number; putIntoPots: number } {
  return {
    expenses: figures.expensesOutsidePots + figures.unfundedPotSpending,
    putIntoPots: figures.putIntoPots,
  };
}

export function plannedFigures(input: {
  categoryTargetsMonthly: number[];
  potMonthlyAmounts: (number | null)[];
}): { budgetedSpending: number; plannedForPots: number; totalBudgeted: number } {
  const budgetedSpending = input.categoryTargetsMonthly.reduce((a, b) => a + b, 0);
  const plannedForPots = input.potMonthlyAmounts.reduce<number>(
    (sum, amount) => sum + (amount ?? 0),
    0,
  );
  return {
    budgetedSpending,
    plannedForPots,
    totalBudgeted: budgetedSpending + plannedForPots,
  };
}

export function expectedIncome(
  override: number | null,
  regular: number | null,
): number | null {
  return override ?? regular;
}
