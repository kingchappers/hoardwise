# Show what you've spent, put away and budgeted (HOA-54, HOA-55)

## Why

The month's "spending" figure counts expenses, including spending paid from pots, but not money put into pots. For October 2026 it reads £4,209.40, so "income − spending" (+£671.89) looks comfortable. Once the £1,414.79 put into pots is counted, the month is £261.34 over income.

The owner treats pot contributions as "paying yourself first": money reserved for a purpose, so it is an outgoing. They overcommitted for the month because nothing showed this. The fix is two parts, in this order:

1. **Actual (HOA-54):** show what was spent and what was put away, against income.
2. **Plan (HOA-55):** show the same picture before the month happens, against expected income, so overcommitting is visible while planning.

## What the person sees

### Month summary (actual)

- An **Income** bar with its figure (£4,881.29 in October).
- A **Where it went** bar below it, in two parts: Expenses (£3,727.84) and Put into pots (£1,414.79). The bars share one scale, so a longer outgoings bar is visible at a glance.
- **Spent + put away** (£5,142.63), and a line saying how far over or under income that is ("£261.34 more than your income"). Plain words, plus an icon or sign, never colour alone.
- **Actually spent** (£4,209.40) as a separate, smaller figure, with a short explainer: money that left your accounts, being your expenses plus spending paid out of pots. Pot spending comes out of what you put away earlier, so it is not added to "Spent + put away".

Mockup the owner approved: layout "A" in `.superpowers/brainstorm/*/content/month-and-plan-v2.html` (not committed).

### Plan page (budgeted)

- Same bar layout as above, for the planned month.
- **Expected income:** defaults to the person's regular income from previous months. They can set their own figure instead ("Set your own").
- **Planned bar:** Budgeted spending (sum of category targets) plus Planned for pots (sum of each pot's monthly amount).
- **Total budgeted**, and how far over or under expected income it is.
- Each pot's planned amount is **entered on the Plan page** (its Pots tab). The totals update as the person types.
- A short note: spending you expect to do from a pot is inside that pot's planned amount, not added on top.

## Goals

- One definition of each figure, used identically in the app, `month_review` and `chart_data` (month-summary), and written down once.
- Pot spending funded by an earlier allocation is never counted twice, in actuals or in the plan.
- Figures reconcile: income − (expenses + put into pots) = left after pots.
- October 2026 data reproduces the numbers above.
- The plan view reuses the actual view's component and wording, so "actual" and "planned" read the same way.

## Non-goals

- Per-month planned pot amounts. A pot has one monthly amount (as today), used for every month.
- Entering expected pot spending separately from the monthly amount (see decisions below).
- Forecasting beyond the "regular income" Hoardwise already works out.
- Changing how pots, targets or transactions are stored beyond what the above needs.

## Anti-goals

The person must never feel any of these:

- Told off. Over income is shown calmly and factually, no alarm styling, no flashing or motion, with the brand rules in `docs/brand.md` (theme tokens only, gold never as text, WCAG AA, colour never the only signal).
- Confused by two "spent" numbers. Both are always labelled in plain words, with the explainer.
- Surprised by a different total on different screens.

## Constraints

- Follow `SECURITY.md` and reference control IDs in commits. Any new API field is validated at the boundary (IO-01).
- The AWS-hosted and self-hosted builds share one implementation. The browser demo must still work (it has its own in-memory API and seed), so any new setting needs a demo path.
- `docs/openapi.yaml`, the generated OpenAPI and agent docs, and the MCP tool descriptions must stay in step with any response change (contract tests exist).
- Re-run `yarn screenshots` and commit the images, since pages shown on the About page change.

## Facts from the code (checked 2026-11-02)

- `spending.total` in `src/mcp/review.ts` sums `EXPENSE` transactions. Pot spending is an `EXPENSE` in a pot category, so it is already inside £4,209.40. Money put into pots is `SET_ASIDE` (and automatic contributions via `autoContribute`); money moved back out is `TAKE_OUT`.
- A pot already has `monthlyAmount` (nullable) in `PotSettings`/`PotSummary`, edited today in `app/components/pots/PotHistorySheet.tsx` and validated in `src/api/pots.ts`. `autoContribute` needs it. So the planned pot amount exists, and for most pots is simply unset.
- The Plan page (`app/routes/plan.tsx`) has three tabs: Budgets, Pots, Recurring.
- `review.ts` already works out a regular income (`regularAmount`, `usual`) and has an `incomeQuestion`. Expected income should reuse this, not a second calculation.
- Pot categories have no spending target (`target: null`).

## Decisions

The owner decided:

- Both figures are shown: "Spent + put away" prominently, "Actually spent" as a smaller figure with an explainer.
- Layout A (bar against income), with the income figure shown and the explainer under "Actually spent".
- A matching bar on the Plan page, comparing the budget with expected income.
- Expected income is based on previous months, or a figure the person enters.
- Planned pot amounts are entered on the Plan page, with the total updating as they do.
- **Unfunded pot spending counts.** Spending from a pot is left out of "Spent + put away" while the pot holds enough to cover it. Any part of a spend that goes beyond the pot's balance (a zero or overdrawn pot) did not come from money put away, so it is counted in "Spent + put away". This never double-counts funded spending and never hides money that really left. The owner agreed to this on 2026-11-02.

My calls (the owner has not confirmed these):

- **Planned pot amount = the pot's existing `monthlyAmount`.** No new concept. Entering it on the Plan page edits the same field.
- **No separate "expected pot spend" in this work.** Because the plan counts only the monthly amount per pot, there is nothing to double count; pot categories keep `target: null`. If a person later wants to plan spend from a pot, that is a follow-up.
- **"Put into pots" = `SET_ASIDE` plus automatic contributions, net of `TAKE_OUT`.** The builder checks this against £1,414.79 for October and fixes the rule to whatever reproduces it.
- **"Spent + put away" = expenses outside pots + put into pots + any unfunded pot spending** (see Decisions). Funded pot spending is excluded because it draws down earlier allocations. The builder decides how "funded" is measured from the pot's running balance (`PotMonth.opening` and `closing`), and tests it with a pot that is overdrawn.
- **Expected income override is one value** that applies to every month until changed, not one per month. It is per person, like other settings, and can be cleared to go back to the regular amount.
- **If no rule for "put into pots" reproduces October's numbers from the seed**, the builder stops and reports the difference rather than choosing. The owner's figures are the target.
- **The Plan page shows one headline figure**, Total budgeted, with its over/under line. It has no "Actually spent" equivalent. The shared bar component takes the labels as props.
- **No history means no income bar.** With no previous months, the Plan page shows "Set your own" in place of the expected income and no income bar or over/under line until a figure exists. When the regular-income rule is unsure, it uses the same suggestion that `incomeQuestion` already offers.
- **Plan covers the current and upcoming months.** A pot's monthly amount is one value for all months, so past months show actuals only and no planned bar.
- **Entering a pot's amount on the Plan page uses the same save as the pot sheet**, so a pot with automatic contributions behaves exactly as it does today, and the existing explanation of that is shown beside the field.
- **The approved mockup is committed** next to this document as `2026-11-02-spent-and-budgeted-mockup.html`, as the visual reference for proportions and placement.

## Left to the builder

- Where the override is stored (a settings record, or a field alongside targets) and its API shape.
- Where the Plan summary sits (above the tabs so it stays visible on Budgets and Pots, is my suggestion).
- The wording of the explainer and the over/under line, within `docs/brand.md`.
- How the month summary appears in `chart_data`/`month_review` (new fields next to the existing ones; keep existing field names so nothing breaks).
- Which month the Plan page is planning, if it doesn't already have one.
- Tests: figures reconcile for October 2026 seed data; pot spending funded by an allocation is not double counted; income override beats the regular amount.
