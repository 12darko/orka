export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
}

export interface Plan {
  explanation?: string;
  steps: PlanStep[];
}

/** True when the steps (titles and order) are the same - i.e. only statuses changed. */
export function sameStructure(a: Plan | undefined, b: Plan): boolean {
  if (!a || a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, i) => step.title.trim() === b.steps[i].title.trim());
}

export function formatPlan(plan: Plan): string {
  const marks: Record<PlanStepStatus, string> = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };
  return plan.steps.map((s, i) => `${marks[s.status]} ${i + 1}. ${s.title}`).join('\n');
}
