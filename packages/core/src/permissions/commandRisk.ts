import * as path from 'node:path';
import type { PermissionCategory, RiskLevel } from './PermissionManager';

export interface CommandClassification {
  category: Extract<PermissionCategory, 'command' | 'git'>;
  risk: RiskLevel;
  reason?: string;
}

/** Destructive or hard-to-reverse patterns. Matched against each segment of a command line. */
const DANGEROUS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-z]*r[a-z]*|-[a-z]*f[a-z]*r|--recursive)\b/i, 'recursive delete'],
  [/\brm\s+.*\s-[a-z]*[rf]/i, 'forced/recursive delete'],
  [/\b(remove-item|ri|rm|del|erase)\b.*-recurse/i, 'recursive delete'],
  [/\b(rd|rmdir)\b.*\/s/i, 'recursive delete'],
  [/\b(del|erase)\b.*\/[sq]/i, 'bulk delete'],
  [/\bformat\s+[a-z]:(\s|$)|\bformat-volume\b/i, 'disk format'],
  [/\b(mkfs|diskpart|fdisk|dd\s+if=)/i, 'disk operation'],
  [/\b(shutdown|reboot|halt|poweroff|stop-computer|restart-computer)\b/i, 'machine power'],
  [/\bgit\s+push\b/i, 'git push'],
  [/\bgit\s+reset\s+.*--hard\b|\bgit\s+reset\s+--hard\b/i, 'git reset --hard'],
  [/\bgit\s+clean\b.*-[a-z]*f/i, 'git clean'],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/i, 'discard working tree changes'],
  [/\bgit\s+branch\s+.*-D\b/, 'force delete branch'],
  [/\bgit\s+(rebase|filter-branch|filter-repo|reflog\s+expire|gc\s+--prune)/i, 'history rewrite'],
  [/\bgit\s+stash\s+(drop|clear)\b/i, 'drop stash'],
  [/--force\b|--force-with-lease\b|\s-f\s+origin\b/i, 'forced operation'],
  [/\b(drop\s+(database|table|schema)|truncate\s+table)\b/i, 'database destruction'],
  [/\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b.*\|\s*(sh|bash|zsh|iex|invoke-expression|pwsh|powershell)\b/i, 'pipe download to shell'],
  [/\b(iex|invoke-expression)\b/i, 'dynamic code execution'],
  [/\bsudo\b|\brunas\b/i, 'elevated privileges'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\b|\bchown\s+-R\b/i, 'permission change'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bdotnet\s+nuget\s+push\b|\bcargo\s+publish\b|\btwine\s+upload\b/i, 'publish package'],
  [/\b(kubectl\s+delete|terraform\s+(destroy|apply)|docker\s+(system|volume|image)\s+prune)\b/i, 'infrastructure change'],
  [/\breg(\.exe)?\s+(delete|add)\b|\bset-executionpolicy\b|\bnetsh\b|\bbcdedit\b/i, 'system configuration'],
  [/>\s*\/dev\/sd[a-z]/i, 'raw device write'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  // -EncodedCommand and every abbreviation PowerShell accepts (-e, -ec, -en, -enc, -enco...), also
  // with "--", "/" or a typographic dash.
  [/\b(powershell|pwsh)(\.exe)?\b.*\s(--?|[/\u2013\u2014\u2015])e(c|n[a-z]*)?(\s|:|$)/i, 'encoded PowerShell command'],
  [/\bstart-process\b.*-verb\s+runas\b/i, 'elevated privileges'],
  [/\bcertutil(\.exe)?\b.*-(urlcache|decode|encode)\b|\bbitsadmin(\.exe)?\b.*\/transfer\b/i, 'download with a system tool'],
  [/\b(mshta|regsvr32|rundll32|wscript|cscript)(\.exe)?\b/i, 'script host execution'],
  [/\b(set|add|remove)-mppreference\b|\bnetsh\s+advfirewall\b|\bdisable-windowsoptionalfeature\b/i, 'security settings'],
  [/\bschtasks(\.exe)?\b.*\/(create|change|delete)\b|\b(register|unregister|set)-scheduledtask\b|\bcrontab\b/i, 'scheduled task'],
  [/\bsc(\.exe)?\s+(create|delete|config)\b|\b(new|remove|set)-service\b|\bsystemctl\s+(enable|disable|mask|stop)\b/i, 'system service'],
  [/\bsetx\b|\[environment\]::setenvironmentvariable\s*\([^)]*,\s*['"]?(machine|user)\b/i, 'persistent environment change'],
  [/\b(npm|pnpm)\s+(i|install|add|uninstall|remove)\b.*\s(-g|--global)\b|\byarn\s+global\s+(add|remove)\b/i, 'global package change'],
  [/\bgit\s+config\s+.*--(global|system)\b/i, 'global git configuration'],
  [/\bicacls\b.*\/(grant|deny|reset|setowner)|\btakeown\b/i, 'permission change'],
  [
    /\b(iwr|invoke-webrequest|irm|invoke-restmethod|start-bitstransfer)\b.*\s-(outfile|destination)\b|\bcurl(\.exe)?\b.*\s(-[a-z]*[oO][a-z]*|--output|--remote-name(-all)?)(\s|$)|\bwget\b(?!.*\s-q?O\s*-(\s|$))|\(new-object\s+(system\.)?net\.webclient\)\.download(file|data)/i,
    'download to a file',
  ],
];

/**
 * Inline code for an interpreter (node -e, python -c, ...). Its file, process and network access
 * cannot be read off the command line the way a plain command's can, so code that uses any of
 * them asks for approval; harmless one-liners (printing a version, a quick calculation) do not.
 */
const INTERPRETER = /^(node|nodejs|bun|deno|python[0-9.]*|py|perl|ruby|php|lua|osascript)(\.exe)?$/i;
const INLINE_FLAG = /^(-e|--eval|-p|--print|-c|-r|eval|-command)$/i;

/** The token without surrounding quotes (a loop: a regex like /["']+$/ backtracks on long runs of quotes). */
function unquote(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && (token[start] === '"' || token[start] === "'")) start++;
  while (end > start && (token[end - 1] === '"' || token[end - 1] === "'")) end--;
  return token.slice(start, end);
}

/** An interpreter started with inline code (node -e, python -c, ...), found token by token (linear). */
function hasInlineCode(command: string): boolean {
  let interpreter = false;
  for (const token of command.split(/[\s;&|()]+/)) {
    const name = unquote(token).split(/[\\/]/).pop() ?? '';
    if (INTERPRETER.test(name)) interpreter = true;
    else if (interpreter && INLINE_FLAG.test(token)) return true;
  }
  return false;
}
const INLINE_SENSITIVE = new RegExp(
  [
    // files
    'write(file|filesync)?|appendfile|createwritestream|copyfile|rename(sync)?\\(|unlink|\\brm(sync|dir)?\\(|mkdir|chmod|symlink',
    // Bounded, so a long line of "open(" without ")" stays fast.
    "open\\([^)]{0,300}['\"](w|a|x|r\\+)",
    'shutil|pathlib|os\\.(remove|unlink|rename|replace|makedirs|system|popen|chmod)',
    // processes
    'child_process|\\bexec(sync|file)?\\(|\\bspawn|subprocess|process\\.(kill|dlopen)|\\beval\\(|\\bfunction\\(',
    // network
    'https?:|fetch\\(|\\bnet\\b|\\bdgram\\b|\\btls\\b|socket|urllib|requests\\.|http\\.client|webclient|invoke-',
    // places outside the project
    'homedir|expanduser|userprofile|appdata|\\bhome\\b|process\\.env|os\\.environ|getenv|\\$env:|%\\w+%|~[\\\\/]|[a-z]:[\\\\/]|\\/etc\\/|\\/usr\\/|\\.\\.[\\\\/]\\.\\.',
  ].join('|'),
  'i',
);

/** Verbs that write, move or delete files; combined with a path outside the workspace they need approval. */
const WRITE_VERBS = new RegExp(
  '(^|[\\s;&|(])(' +
    [
      'rm', 'del', 'erase', 'rd', 'rmdir', 'remove-item', 'ri', 'mv', 'move', 'move-item', 'mi', 'cp', 'copy', 'copy-item', 'cpi',
      'xcopy', 'robocopy', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'new-item', 'ni', 'mkdir', 'md', 'touch', 'tee',
      'tee-object', 'ln', 'ren', 'rename', 'rename-item', 'rni', 'chmod', 'chown', 'unzip', 'expand-archive', 'tar',
    ].join('|') +
    ')(\\.exe)?(?=\\s)',
  'i',
);
/** Locations outside the workspace that are fine to write (null devices and temp folders). */
const HARMLESS_TARGET = /^(\/dev\/(null|stdout|stderr)|\$null|nul|\/tmp(\/|$)|\$env:(temp|tmp)\b|%(temp|tmp)%)/i;
const HOME_REF =
  /(^|[\s"'=(])(~[\\/]|\$\{?home\b|\$env:(userprofile|appdata|localappdata|programfiles|programdata|windir|systemroot)\b|%(userprofile|appdata|localappdata|programfiles|programdata|windir|systemroot)%)/i;

export interface CommandContext {
  /** Absolute workspace root; enables the outside-the-workspace check. */
  workspaceRoot?: string;
  /** Absolute directory the command runs in (default: the root). */
  cwd?: string;
  /**
   * The config of the repository the command runs in (`cwd`) makes git run programs (see
   * gitConfigRisk): any git command asks.
   */
  gitRisk?: string;
}

const GIT_WRITE = /\bgit\s+(commit|merge|rebase|tag|push|reset|stash|cherry-pick|revert|am|apply|pull|checkout\s+-b|switch\s+-c|branch\s+-[dDmM]|remote\s+(add|remove|set-url)|rm)\b/i;

/**
 * Commands that only read, tested against each stage's words as the shell passes them on (see
 * stageOf). Options that make one of them run a program or write a file keep it out.
 */
const SAFE_PREFIXES = [
  /^(ls|dir|pwd|cd|echo|cat|type|head|tail|wc|which|where|whoami|date|printenv|file|stat|du|df)(\.exe)?(\s|$)/i,
  // With arguments, env runs them as a command.
  /^env\s*$/i,
  // tree -o writes its listing to a file (-R adds -o).
  /^tree(\.com)?(?!.*\s(-[a-z]*[or]|--output))(\s|$)/i,
  /^(get-childitem|gci|get-content|gc|get-location|gl|test-path|select-string|sls|get-item|gi|resolve-path|measure-object|write-output|write-host)(\s|$)/i,
  // Names only: with -ArgumentList, -Syntax or -ShowCommandInfo, Get-Command runs a script's dynamicparam block.
  /^(get-command|gcm)(\s+(?!-(ar|sy|sh))[\w.:-]+)*\s*$/i,
  /^(grep|findstr)(\.exe)?(?!.*\s--pre)(\s|$)/i,
  // ripgrep runs --pre for every file it searches, --hostname-bin, and decompressors with -z.
  /^rg(\.exe)?(?!.*\s(--(pre|hostname-bin|search-zip)\b|-[a-z]*z))(\s|$)/i,
  // find runs (-exec, -execdir, -ok, -okdir), deletes or writes files (-fprint, -fls) with these.
  /^find(\.exe)?(?!.*\s-(exec|ok|delete|fprint|fls))(\s|$)/i,
  /^(?!.*\s--output(=|\s|$))git(\.exe)?(\s+--no-pager)?\s+(status|diff|log|show|branch(\s+(-a|-r|--list|-v|-vv))*\s*$|remote\s+-v\s*$|rev-parse|ls-files|blame|describe|shortlog|config\s+--get(-[a-z]+)?)(\s|$)/i,
  // Version checks (not yarn, pnpm, dotnet, nor rustup's cargo and rustc: they run a version or SDK the project names).
  /^(node|npm|npx|python|python3|py|pip|go|java|javac|tsc|deno|bun|unity|git)\s+(-v|--version|version)\s*$/i,
];

/** Commands whose options can make them run a program or write a file: they are safe only with literal words. */
const OPTION_SENSITIVE = /^(rg|grep|findstr|find|tree|git)(\.exe|\.com)?$/i;
/** Commands that change the folder the rest of the line runs in. */
const DIR_CHANGE = /^(cd|chdir|pushd|popd|set-location|sl|push-location|pop-location)(\.exe)?(\s|$)/i;
/** Git started by the line, also by a quoted name or a path (`"git"`, `/usr/bin/git`). */
const RUNS_GIT = /(^|[\s;&|(`'"\\/])git(\.exe|\.cmd|\.bat|\.com)?(['"\s]|$)/i;
/** Forms that look like grouping but run nothing: ${name}, ${env:NAME}, git's HEAD@{1} and @{u}. */
const INERT_BRACES = /\$\{[A-Za-z_][\w:]*\}|@\{[\w.:/-]*\}/g;
/** cmd's substring and replace forms (%PATH:~0,0%, %PATH:a=%) make characters the line does not show, separators too. */
const CMD_SUBSTRING = /%[^%\s]*:(~|[^%]*=)[^%]*%/;
/** Redirections that write no file: copying or closing a stream (2>&1, >&2, 2>&-), or into the null device. */
const HARMLESS_REDIRECT = /[\d*]?>&(\d+|-)|[\d*&]?>{1,2}\s*(\$null|\/dev\/null|nul)(?![\w./\\:-])/gi;

/** One stage of a command line (a command and its arguments, between separators and pipes). */
interface Stage {
  /** Its words as the shell passes them on (quotes removed, and backslashes after the program's name), joined by spaces. */
  text: string;
  /**
   * Every word says what it passes: no variable ($1, ${x}, $'...', PowerShell's @splat) and no
   * wildcard that can stand for an option (`rg foo *` next to a file named "--pre=x.sh").
   */
  literal: boolean;
}

/**
 * The line has quotes some shell reads differently: an escaped quote (bash's \" ends a PowerShell
 * string), bash's $'...', cmd's ^", or a typographic quote (PowerShell's, which also ends a '...').
 */
function quotesAmbiguous(line: string): boolean {
  if (/[\u2018-\u201f]/.test(line)) return true;
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (quote === "'") {
      if (c === "'") quote = '';
    } else if (quote === '"') {
      if (c === '\\' && next === '"') return true;
      if (c === '"') quote = '';
    } else if ((c === '\\' || c === '^' || c === '$') && (next === '"' || next === "'")) return true;
    else if (c === '"' || c === "'") quote = c;
  }
  return false;
}

function stageOf(raw: string): Stage {
  const tracksQuotes = !quotesAmbiguous(raw);
  const words: string[] = [];
  let literal = true;
  let word: string | undefined;
  let wildcard = false;
  let quote = '';
  const endWord = () => {
    if (word === undefined) return;
    if (wildcard && /^[-*?[]/.test(word)) literal = false;
    // A backslash in the program's name makes it a path; elsewhere bash drops it (r\g, --p\re).
    words.push(words.length ? word.replace(/\\/g, '') : word);
    word = undefined;
    wildcard = false;
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const next = raw[i + 1] ?? '';
    if (quote === "'") {
      if (c === "'") quote = '';
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = '';
      else {
        if (c === '$' && /[\w{(@*#?!$^-]/.test(next)) literal = false;
        word += c;
      }
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      if (word === undefined) word = '';
      if (c === '"' || c === "'" || /[\u2018-\u201f]/.test(c)) {
        // Where shells read quotes differently they are dropped, and what they enclose counts as unquoted.
        if (tracksQuotes) quote = c;
        continue;
      }
      if (c === '$' && /[\w{(@*#?!$^'"-]/.test(next)) literal = false;
      else if (c === '@' && word === '' && /[A-Za-z_]/.test(next)) literal = false;
      else if (c === '*' || c === '?' || c === '[') wildcard = true;
      word += c;
    }
  }
  endWord();
  return { text: words.join(' '), literal };
}

function isSafeStage(stage: Stage): boolean {
  if (!SAFE_PREFIXES.some((re) => re.test(stage.text))) return false;
  // A variable or a wildcard could still spell an option that runs a program (rg --pr$1e).
  return stage.literal || !OPTION_SENSITIVE.test(stage.text.split(' ')[0]);
}

/**
 * The line may start git, also by a name written with quotes, escapes or variables (g''it,
 * gi$1t): the repository's git config is worth reading for it.
 */
export function mayRunGit(command: string): boolean {
  // What is left with quotes, escapes and variables ($1 is one digit, $x a whole name) taken out.
  return RUNS_GIT.test(command) || RUNS_GIT.test(command.replace(/["'`^\\\u2018-\u201f]|\$\{\w*\}|\$(\d|[@*]|[A-Za-z_]\w*)|%[^%\s]*%/g, ''));
}

/**
 * The line can start a program other than the ones its stages name: command or process
 * substitution ($(...), `...`, <(...), >(...), zsh's =(...)), a single & (bash runs what follows
 * in the background, PowerShell and cmd call it), a lone CR (a statement break in PowerShell), cmd's
 * substring forms, or, outside single quotes, a parenthesis or brace (PowerShell runs groups,
 * sub-expressions and script blocks, also as arguments). Quotes count only where every shell reads
 * them alike.
 */
function startsOtherPrograms(line: string): boolean {
  if (/[`\u0085\u2028\u2029]|\r(?!\n)/.test(line) || CMD_SUBSTRING.test(line)) return true;
  if (line.replace(/&&|\d*>&\d*|&>/g, '').includes('&')) return true;
  const text = line.replace(INERT_BRACES, '');
  const tracksQuotes = !quotesAmbiguous(text);
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = '';
    } else if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) return true;
    } else if (tracksQuotes && (c === "'" || c === '"')) quote = c;
    else if (c === '(' || c === '{') return true;
  }
  // An unclosed quote: the shell reads the line some other way.
  return quote !== '';
}

function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\r?\n|\r/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function classifyCommand(command: string, context: CommandContext = {}): CommandClassification {
  const trimmed = command.trim();
  for (const [pattern, reason] of DANGEROUS) {
    if (pattern.test(trimmed)) {
      return { category: /\bgit\b/i.test(trimmed) ? 'git' : 'command', risk: 'dangerous', reason };
    }
  }
  if (hasInlineCode(trimmed) && INLINE_SENSITIVE.test(trimmed)) {
    return { category: 'command', risk: 'dangerous', reason: 'inline script with file, process or network access' };
  }
  if (context.workspaceRoot && writesOutside(trimmed, context.workspaceRoot, context.cwd ?? context.workspaceRoot)) {
    return { category: 'command', risk: 'dangerous', reason: 'writes outside the workspace' };
  }
  // A pipeline is safe only if every stage is safe (e.g. `git log | head`).
  const stages = segments(trimmed)
    .flatMap((p) => p.split('|'))
    .map(stageOf)
    .filter((s) => s.text);
  const runsGit = mayRunGit(trimmed) || stages.some((s) => RUNS_GIT.test(s.text));
  if (context.gitRisk && runsGit) {
    return { category: 'command', risk: 'dangerous', reason: 'git runs programs from this repository' };
  }
  if (GIT_WRITE.test(trimmed)) return { category: 'git', risk: 'normal', reason: 'changes git state' };

  const hasRedirect = />/.test(trimmed.replace(HARMLESS_REDIRECT, ''));
  // Git's risk is known for the folder the command starts in, not for one the line moves to.
  const movesGit = runsGit && stages.some((s) => DIR_CHANGE.test(s.text));
  if (!hasRedirect && !movesGit && !startsOtherPrograms(trimmed) && stages.length > 0 && stages.every(isSafeStage)) {
    return { category: 'command', risk: 'safe' };
  }
  return { category: 'command', risk: 'normal' };
}

/** A file-writing command that names a path outside the workspace (absolute, home-relative or ../..). */
function writesOutside(command: string, root: string, cwd: string): boolean {
  // Every redirection into a file: >, >>, 2>, &>, *>, and >&file (not >&2 or 2>&1, which copy a stream).
  const redirectTargets = [...command.matchAll(/(?<!>)>{1,2}(?!&[\d-])&?\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)].map((m) => m[1].replace(/^["']|["']$/g, ''));
  const hasWriteVerb = WRITE_VERBS.test(command);
  if (!hasWriteVerb && !redirectTargets.some((t) => !HARMLESS_TARGET.test(t))) return false;
  if ((hasWriteVerb && HOME_REF.test(command)) || redirectTargets.some((t) => HOME_REF.test(t))) return true;
  const candidates = hasWriteVerb ? [...pathTokens(command), ...redirectTargets] : redirectTargets;
  return candidates.some((token) => !HARMLESS_TARGET.test(token) && isOutside(token, root, cwd));
}

function pathTokens(command: string): string[] {
  const tokens: string[] = [];
  for (const m of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s"';&|<>()]+)/g)) {
    const token = (m[1] ?? m[2] ?? m[3] ?? '').replace(/^-\w+[:=]/, '');
    const looksLikePath = /^[a-z]:[\\/]/i.test(token) || token.startsWith('/') || token.startsWith('\\\\') || /(^|[\\/])\.\.([\\/]|$)/.test(token);
    if (looksLikePath) tokens.push(token);
  }
  return tokens;
}

function isOutside(token: string, root: string, cwd: string): boolean {
  const windows = /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\');
  const p = windows ? path.win32 : path.posix;
  if (!windows && /^[a-z]:[\\/]/i.test(token)) return true;
  // On Windows "/s", "/q" are switches, not paths.
  if (windows && token.startsWith('/') && !token.startsWith('//')) return false;
  const resolved = p.resolve(cwd, token);
  const relative = windows ? p.relative(root.toLowerCase(), resolved.toLowerCase()) : p.relative(root, resolved);
  return relative.startsWith('..') || p.isAbsolute(relative);
}
