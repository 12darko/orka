import { t } from '../i18n';
import { formatPlan, type Plan, type PlanStep, sameStructure } from '../planning/Plan';
import type { Tool } from './Tool';
import { ToolError } from './Tool';

interface UpdatePlanInput {
  explanation?: string;
  steps: PlanStep[];
}

export const updatePlanTool: Tool<UpdatePlanInput> = {
  name: 'update_plan',
  description:
    'Create or update the task plan shown to the user. Use it for any task with several steps: first to propose the plan, ' +
    'then to mark progress (exactly one step in_progress at a time; mark steps completed as soon as they are done). ' +
    'Always send the full list of steps. Changing the steps themselves may require the user\'s approval.',
  inputSchema: {
    type: 'object',
    properties: {
      explanation: { type: 'string', description: 'One or two sentences on the approach or why the plan changed.' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short, concrete step.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['steps'],
  },
  describe(input, ctx) {
    const plan: Plan = { explanation: input.explanation, steps: input.steps ?? [] };
    // Status-only updates never need approval; a new or restructured plan is a "plan" action.
    if (sameStructure(ctx.plan, plan)) return { category: 'read', risk: 'safe', title: t('Update plan progress') };
    return {
      category: 'plan',
      risk: 'normal',
      title: ctx.plan ? t('Revise plan') : t('Propose plan'),
      detail: [input.explanation, formatPlan(plan)].filter(Boolean).join('\n\n'),
    };
  },
  async execute(input, ctx) {
    if (!input.steps?.length) throw new ToolError('steps must contain at least one step.');
    const inProgress = input.steps.filter((s) => s.status === 'in_progress').length;
    const plan: Plan = { explanation: input.explanation, steps: input.steps.map((s) => ({ title: s.title.trim(), status: s.status })) };
    ctx.setPlan(plan);
    const note = inProgress > 1 ? '\nNote: keep only one step in_progress at a time.' : '';
    return { content: `Plan updated:\n${formatPlan(plan)}${note}` };
  },
};
