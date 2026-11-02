import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface PlanDrafts {
  drafts: Record<string, number | null>;
  setDraft: (categoryId: string, pence: number | null) => void;
  clearDraft: (categoryId: string) => void;
}

const NO_DRAFTS: PlanDrafts = {
  drafts: {},
  setDraft: () => {},
  clearDraft: () => {},
};

const PlanDraftContext = createContext<PlanDrafts>(NO_DRAFTS);

export function PlanDraftProvider({ children }: { children: React.ReactNode }) {
  const [drafts, setDrafts] = useState<Record<string, number | null>>({});

  const setDraft = useCallback((categoryId: string, pence: number | null): void => {
    setDrafts(current => ({ ...current, [categoryId]: pence }));
  }, []);

  const clearDraft = useCallback((categoryId: string): void => {
    setDrafts(current => {
      if (!(categoryId in current)) return current;
      const { [categoryId]: _removed, ...rest } = current;
      return rest;
    });
  }, []);

  const value = useMemo(() => ({ drafts, setDraft, clearDraft }), [drafts, setDraft, clearDraft]);
  return <PlanDraftContext.Provider value={value}>{children}</PlanDraftContext.Provider>;
}

export function usePlanDrafts(): PlanDrafts {
  return useContext(PlanDraftContext);
}
