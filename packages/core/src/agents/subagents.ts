/** Specialized helper agents the main agent can delegate to via the run_subagent tool. */
export interface SubagentProfile {
  name: string;
  /** Shown to the main agent so it knows when to delegate. */
  description: string;
  /** "readonly": read/search/git-read tools only. "full": may also edit files and run commands. */
  access: 'readonly' | 'full';
  /** Extra role instructions appended to the sub-agent's system prompt. */
  instructions?: string;
  maxIterations?: number;
}

export const READONLY_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'search_code',
  'git_status',
  'git_diff',
  'git_log',
  'git_branch',
  'code_outline',
  'load_skill',
  'web_fetch',
]);

export const DEFAULT_SUBAGENTS: SubagentProfile[] = [
  {
    name: 'explore',
    description:
      'Read-only investigator. Searches and reads the codebase and reports findings with file paths and line numbers. ' +
      'Use it for broad questions ("where is X handled?", "how does Y flow through the system?") so your own context stays focused.',
    access: 'readonly',
    instructions:
      'Investigate thoroughly but efficiently: search first, then read the most relevant parts. ' +
      'Report concrete findings with file paths and line numbers, and say what you could not find.',
  },
  {
    name: 'review',
    description:
      'Read-only code reviewer. Examines changed code (git diff, edited files) for bugs, missed edge cases, broken ' +
      'contracts and convention violations. Use it before finishing non-trivial changes.',
    access: 'readonly',
    instructions:
      'Review for correctness first, then robustness, then conventions. For each finding give the file and line, ' +
      'what is wrong, a concrete failure scenario, and a suggested fix. Say plainly if you found nothing significant.',
  },
  {
    name: 'worker',
    description:
      'Implementer for a clearly specified, self-contained change: can edit files and run commands. Give it precise ' +
      'instructions and acceptance criteria; it reports what it changed and how it verified it.',
    access: 'full',
    instructions:
      'Make exactly the requested change, following the existing code style. Verify it with the relevant build or tests ' +
      'when possible. Report the files you changed and the verification result.',
  },
];
