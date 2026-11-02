# Spent, Put Away and Budgeted Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the month's expenses plus money put into pots against income (HOA-54), and the same picture on the Plan page against expected income (HOA-55).

**Architecture:** One pure module, `src/shared/monthFigures.ts`, defines every figure. The MCP tools, the Home summary and the Plan summary all call it, so the definition cannot drift. Expected income is a new per-person setting behind a small API route; planned pot amounts reuse each pot's existing `monthlyAmount`.

**Tech Stack:** TypeScript, React 19, Mantine 8, TanStack Query, Vitest, the existing store/router in `src/`.

**Spec:** `docs/superpowers/specs/2026-11-02-spent-and-budgeted-design.md` (visual reference: `docs/superpowers/specs/2026-11-02-spent-and-budgeted-mockup.html`)

## Global Constraints

- Amounts are integer pence everywhere; the UI formats them with `formatPence` from `~/lib/money`.
- Colours come from Mantine theme tokens or `--hw-*` variables only; gold is never text; colour never carries meaning alone (pair with a sign or icon); no motion (`docs/brand.md`).
- Labels in plain words: "Spent + put away", "Actually spent", "Put into pots", "Expected income", "Total budgeted".
- "Spent + put away" = expenses outside pots + put into pots + unfunded pot spending. "Actually spent" = every `EXPENSE`, pot spending included.
- Put into pots = `setAside + autoAdded − takeOut`, summed over the month's pots.
- Validate new API input at the boundary (IO-01). Reference control IDs in commit messages. Never hard-code secrets.
- Keep existing `month_review` / `chart_data` field names; add fields beside them.

## Review Focus

- A pot spent from with no balance (overdrawn): the unfunded part counts in "Spent + put away" (Task 1).
- Expected income when there is no history and no override: no income bar, "Set your own" shown (Task 5).
- A pot amount typed but not saved: the Plan total shows it; leaving without saving does not change saved data (Task 6).
- Income of 0 for the month: no over/under line, no division by zero in bar widths (Task 4).
- Clearing the income override returns to the regular amount (Task 2).

---

### Task 1: The shared figures module

**Files:**
- Create: `src/shared/monthFigures.ts`
- Test: `src/shared/__tests__/monthFigures.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PotMonthInput { opening: number; setAside: number; autoAdded: number; takeOut: number; spent: number }
  export interface FigureTransaction { type: string; categoryId: string; amount: number }
  export interface MonthFigures {
    income: number;
    expensesOutsidePots: number;
    putIntoPots: number;
    unfundedPotSpending: number;
    spentAndPutAway: number;   // expensesOutsidePots + putIntoPots + unfundedPotSpending
    actuallySpent: number;     // every EXPENSE, pot spending included
    leftAfterPots: number;     // income − spentAndPutAway
  }
  export function computeMonthFigures(input: {
    transactions: FigureTransaction[];
    potCategoryIds: ReadonlySet<string>;
    pots: PotMonthInput[];
  }): MonthFigures
  export function plannedFigures(input: {
    categoryTargetsMonthly: number[];
    potMonthlyAmounts: (number | null)[];
  }): { budgetedSpending: number; plannedForPots: number; totalBudgeted: number }
  export function expectedIncome(override: number | null, regular: number | null): number | null
  ```

- [ ] **Step 1: Write the failing tests** in `monthFigures.test.ts`:
  - `reproduces October 2026`: transactions give income 488129, non-pot `EXPENSE` 372784, pot-category `EXPENSE` 48156; pots total put in 141479 (funded, balances cover spending). Assert `actuallySpent === 420940`, `spentAndPutAway === 514263`, `leftAfterPots === -26134`, `income - (expensesOutsidePots + putIntoPots) === leftAfterPots`.
  - `does not count funded pot spending twice`: a pot with `opening: 50000`, `spent: 10000`, nothing put in → `unfundedPotSpending === 0`, `spentAndPutAway` excludes the 10000.
  - `counts the unfunded part of an overdrawn pot`: `opening: 2000, setAside: 1000, spent: 10000` → `unfundedPotSpending === 7000`.
  - `treats take-outs as reducing what was put in`: `setAside: 5000, takeOut: 2000` → `putIntoPots === 3000`.
  - `plannedFigures sums targets and non-null pot amounts`: targets `[397899]`, pots `[1667, null]` → `{ budgetedSpending: 397899, plannedForPots: 1667, totalBudgeted: 399566 }`.
  - `expectedIncome prefers the override`: `(500000, 488129) → 500000`, `(null, 488129) → 488129`, `(null, null) → null`.
- [ ] **Step 2: Run to verify failure:** `yarn vitest run src/shared/__tests__/monthFigures.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement the three functions** in `src/shared/monthFigures.ts`. Unfunded part of one pot = `clamp(spent − max(0, opening + setAside + autoAdded − takeOut), 0, spent)`. Income is the sum of `INCOME` transactions. No imports from `src/api` or `app` so both sides can use it.
- [ ] **Step 4: Run to verify pass:** same command → PASS.
- [ ] **Step 5: Commit:** `git add src/shared && git commit -m "feat: add shared month figures module (HOA-54, HOA-55)"`

### Task 2: Expected income setting (API)

**Files:**
- Create: `src/api/expectedIncome.ts`
- Modify: `src/api/db.ts` (key helper), `src/api/routes.ts:27` (register routes), `docs/openapi.yaml` and regenerated output via `yarn docs:generate`
- Test: `src/api/__tests__/expectedIncome.test.ts`

**Interfaces:**
- Produces: `GET /api/expected-income` → `{ amount: number | null }`; `PUT /api/expected-income` body `{ amount: number }` → `{ amount }`; `DELETE /api/expected-income` → `{ amount: null }`. Store key `pk(userId)` / `expectedIncomeSk = 'SETTING#expectedIncome'`. Amount is a positive integer of pence, at most `MAX_AMOUNT_PENCE`.

- [ ] **Step 1: Write failing tests** (follow `targets.test.ts`): `GET returns null before anything is set`; `PUT stores and GET returns 500000`; `PUT rejects 0, -1, 1.5 and a string with 400`; `DELETE clears it so GET returns null`; `one person's value is not visible to another user`.
- [ ] **Step 2: Run:** `yarn vitest run src/api/__tests__/expectedIncome.test.ts` → FAIL.
- [ ] **Step 3: Implement `getExpectedIncome`, `putExpectedIncome`, `deleteExpectedIncome`** `(event, userId, params) => Promise<ApiResponse>` in the pattern of `src/api/targets.ts`; register in `routes.ts`.
- [ ] **Step 4: Update `docs/openapi.yaml`** with the three operations, run `yarn docs:generate`, then `yarn vitest run src/api` → PASS (the contract/drift tests must pass).
- [ ] **Step 5: Commit:** `feat: add expected income setting (IO-01)`

### Task 3: MCP tools use the shared figures

**Files:**
- Modify: `src/mcp/review.ts` (add `figures` to `MonthReview`, built from `computeMonthFigures`), `src/mcp/tools/chartData.ts:25-38` (month-summary), `src/mcp/tools/monthReview.ts` (description text), `src/mcp/tools/chartData.ts` description
- Test: `src/mcp/__tests__/review.test.ts`, `src/mcp/__tests__/tools.test.ts`

**Interfaces:**
- Consumes: `computeMonthFigures` (Task 1). `buildMonthReview` already receives `pots: PotSummary[]`; use each pot's `months` entry for the review month as `PotMonthInput`.
- Produces: `MonthReview.figures: MonthFigures`. `chart_data` month-summary series becomes four points: `Income`, `Expenses`, `Put into pots`, and `Spent + put away`, plus an `Actually spent` point; `accessibleSummary` names both spent figures in plain words.

- [ ] **Step 1: Write failing tests:** `review exposes figures that reconcile` (October fixture: `figures.leftAfterPots === figures.income - figures.spentAndPutAway`); `month-summary series includes Put into pots and Actually spent`; `month_review keeps spending.total unchanged` (guards the existing field).
- [ ] **Step 2: Run:** `yarn vitest run src/mcp` → FAIL on the new tests only.
- [ ] **Step 3: Implement.** In `chartData.ts`, month-summary needs pots, so load with `loadBudgetWithHistory` and `potsFor(budget, month)` as `monthReview.ts` does (the comment "No view draws pots" no longer holds for this view only; keep the cheaper load for the other views).
- [ ] **Step 4: Run** `yarn vitest run src/mcp` → PASS, then `yarn typecheck`.
- [ ] **Step 5: Commit:** `feat: report spent and put-away figures from MCP tools (AUTH-18)`

### Task 4: The bar component and the Home summary

**Files:**
- Create: `app/components/budget/OutgoingsBar.tsx`
- Modify: `app/components/budget/HomeSummary.tsx`, the Home route that renders it (find with `grep -rn "HomeSummary" app`), `app/lib/queries.ts` only if a hook is missing
- Test: `app/components/budget/__tests__/OutgoingsBar.test.tsx`, `app/components/budget/__tests__/HomeSummary.test.tsx`

**Interfaces:**
- Produces:
  ```tsx
  export interface OutgoingsBarProps {
    incomeLabel: string; incomePence: number | null;
    partsLabel: string;
    parts: { label: string; pence: number }[];     // Expenses, Put into pots
    totalLabel: string;                            // "Spent + put away" / "Total budgeted"
    note?: string;
    secondary?: { label: string; pence: number; explainer: string };   // "Actually spent"
  }
  export function OutgoingsBar(props: OutgoingsBarProps): JSX.Element
  ```
  Bar widths share one scale: `max(incomePence ?? 0, sum(parts))`. Over/under line: "£X more than your income" with `IconArrowUp`, "£X left after pots" with `IconArrowDown`/check; hidden when `incomePence` is null or 0.

- [ ] **Step 1: Write failing tests:** `shows both figures and the explainer` (October values: text "£5,142.63", "£4,209.40", "£261.34 more than your income", explainer contains "paid out of pots"); `shows the income figure under the income bar` ("£4,881.29"); `hides the over/under line when income is zero or unknown`; `income bar is shorter than outgoings bar when over income` (assert inline widths, e.g. `94.9%` vs `100%`).
- [ ] **Step 2: Run:** `yarn vitest run app/components/budget` → FAIL.
- [ ] **Step 3: Implement `OutgoingsBar`** with Mantine tokens (`hoard`, `gold`) for the two parts; gold only as a fill. Replace the Spent/Income rows in `HomeSummary` with `OutgoingsBar` fed by `computeMonthFigures` (import via relative path to `src/shared/monthFigures`, as `app/demo/start.ts` does for `src/demo`); use `usePots(yearMonth)` for pot months. Keep the existing left-to-spend sentence and the "No income recorded yet" line.
- [ ] **Step 4: Run** `yarn vitest run app/components/budget` → PASS; `yarn typecheck`.
- [ ] **Step 5: Commit:** `feat: show spent and put-away bar on the month summary (HOA-54)`

### Task 5: Expected income on the Plan page

**Files:**
- Create: `app/components/plan/ExpectedIncome.tsx`, `app/lib/expectedIncome.ts`
- Modify: `app/lib/api.ts` (add `getExpectedIncome`, `setExpectedIncome`, `clearExpectedIncome` beside `getTargets`), `app/lib/queries.ts` (add `useExpectedIncome`, `useSetExpectedIncome`, `useClearExpectedIncome`, query key)
- Test: `app/lib/__tests__/expectedIncome.test.ts`, `app/components/plan/__tests__/ExpectedIncome.test.tsx`

**Interfaces:**
- Consumes: `expectedIncome(override, regular)` (Task 1); `regularAmount`, `monthHasData` from `src/mcp/calc.ts` (pure).
- Produces: `export function regularIncomeFromHistory(transactions: Transaction[], month: string): number | null` in `app/lib/expectedIncome.ts` (sums `INCOME` per earlier month, passes the maps to `regularAmount`); `ExpectedIncome` component props `{ regular: number | null }` rendering the figure, its source ("Average of your last 3 months" / "Set by you"), a "Set your own" form (`parsePounds`, `SaveStatus`) and a "Use my usual" clear action.

- [ ] **Step 1: Write failing tests:** `regularIncomeFromHistory returns null with fewer than 3 months`; `returns the median of 3 steady months`; `component shows "Set your own" and no figure when nothing is known`; `component shows the override and "Set by you"`; `clearing calls the clear mutation`.
- [ ] **Step 2: Run:** `yarn vitest run app/lib/__tests__/expectedIncome.test.ts app/components/plan` → FAIL.
- [ ] **Step 3: Implement** the lib function, API client methods, hooks (invalidate the expected-income key on set and clear) and the component.
- [ ] **Step 4: Run** the same command → PASS; `yarn typecheck`.
- [ ] **Step 5: Commit:** `feat: add expected income to the Plan page (HOA-55)`

### Task 6: Plan summary with live pot amounts

**Files:**
- Create: `app/components/plan/PlanSummary.tsx`, `app/components/plan/PlanDraftContext.tsx`, `app/components/pots/PotPlanField.tsx`
- Modify: `app/routes/plan.tsx` (wrap in the draft provider; render `PlanSummary` above the tabs), `app/routes/budgets.tsx` (remove `PlanFooter` and its imports), `app/components/pots/PotRow.tsx` (render `PotPlanField` for active pots), `app/lib/targetPlan.ts` (drop `describePlan` if nothing else uses it)
- Test: `app/components/plan/__tests__/PlanSummary.test.tsx`, `app/components/pots/__tests__/PotPlanField.test.tsx`, update `app/routes/__tests__` Plan tests and delete the plan-footer tests

**Interfaces:**
- Consumes: `plannedFigures`, `expectedIncome` (Task 1); `ExpectedIncome` and hooks (Task 5); `OutgoingsBar` (Task 4); `planTargets`'s monthly normalising (`normaliseTargetToMonth` in `app/lib/summary.ts`); `useSavePot`.
- Produces: `PlanDraftContext` with `{ drafts: Record<string, number | null>; setDraft(categoryId: string, pence: number | null): void; clearDraft(categoryId: string): void }`. `PotPlanField` props `{ pot: PotSummary }`: a "Planned per month" `TextInput` that calls `setDraft` on every change, with a Save button that calls `useSavePot` with `{ monthlyAmount, goalAmount: pot.goalAmount, autoContribute: pot.autoAmountNow > 0 && monthly !== null, month: currentYearMonth() }`, then `clearDraft`. `PlanSummary` merges drafts over saved `monthlyAmount` before calling `plannedFigures`, and shows the existing auto-contribute explanation (reuse `TermHelp terms={['monthlyAmount']}`) beside the field.

- [ ] **Step 1: Write failing tests:** `Total budgeted updates as a pot amount is typed` (type "100" in a pot field → summary text changes by £100.00 before Save); `saved total uses the saved amount after leaving without saving` (unmounted field → draft cleared → original total); `shows budgeted spending plus planned for pots` ("Total budgeted: £5,393.78" with targets 397899 and pots 141479); `compares with expected income` ("£512.49 more than expected income" for 488129); `shows Set your own and no over/under line with no income`; `Budgets tab no longer renders the plan footer`.
- [ ] **Step 2: Run:** `yarn vitest run app/components/plan app/components/pots app/routes` → FAIL.
- [ ] **Step 3: Implement** the files above. The pot field sits on the existing Pots tab rows, so entering amounts happens on the Plan page as agreed.
- [ ] **Step 4: Run** the same command → PASS, then `yarn typecheck`.
- [ ] **Step 5: Commit:** `feat: show total budgeted against expected income on Plan (HOA-55)`

### Task 7: Docs, screenshots and final checks

**Files:**
- Modify: `docs/ROADMAP.md`/`docs/DECISIONS.md` only if they list this work; `scripts/screenshots/` fixtures if the Home or Plan pages change; `public/about/*` (regenerated)
- Test: full suite

- [ ] **Step 1:** Run `yarn test && yarn typecheck && yarn build` → all pass.
- [ ] **Step 2:** Run `yarn screenshots` (first run: `yarn playwright install chromium`) and check the changed About images show the new bars.
- [ ] **Step 3:** Run `yarn build:demo` → succeeds; open the demo and confirm the Home bar and the Plan summary render with seeded data.
- [ ] **Step 4:** After release, compare October 2026 on the deployed account: `month_review` and `chart_data` month-summary should give 488129 income, 420940 actually spent, 514263 spent + put away, −26134 left after pots. If they differ, stop and report the difference (spec: the owner's figures are the target).
- [ ] **Step 5: Commit:** `docs: refresh screenshots for the spent and budgeted bars` — then `superpowers:verification-before-completion` before any PR.
