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
  [/\b(powershell|pwsh)(\.exe)?\b.*\s-(e|ec|en|enc|encodedcommand)\s/i, 'encoded PowerShell command'],
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
];

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
  /(^|[\s"'=(])(~[\\/]|\$home\b|\$env:(userprofile|appdata|localappdata|programfiles|programdata|windir|systemroot)\b|%(userprofile|appdata|localappdata|programfiles|programdata|windir|systemroot)%)/i;

export interface CommandContext {
  /** Absolute workspace root; enables the outside-the-workspace check. */
  workspaceRoot?: string;
  /** Absolute directory the command runs in (default: the root). */
  cwd?: string;
}

const GIT_WRITE = /\bgit\s+(commit|merge|rebase|tag|push|reset|stash|cherry-pick|revert|am|apply|pull|checkout\s+-b|switch\s+-c|branch\s+-[dDmM]|remote\s+(add|remove|set-url)|rm)\b/i;

const SAFE_PREFIXES = [
  /^(ls|dir|pwd|cd|echo|cat|type|head|tail|wc|tree|which|where|whoami|date|env|printenv|file|stat|du|df)\b/i,
  /^(get-childitem|gci|get-content|gc|get-location|gl|test-path|select-string|sls|get-item|gi|resolve-path|measure-object|get-command|write-output|write-host)\b/i,
  /^(grep|rg|findstr|find(?!.*(-delete|-exec)))\b/i,
  /^git\s+(status|diff|log|show|branch(\s+(-a|-r|--list|-v|-vv))*\s*$|remote\s+-v|rev-parse|ls-files|blame|describe|shortlog|config\s+--get)/i,
  /^(node|npm|npx|pnpm|yarn|python|python3|py|pip|dotnet|go|cargo|rustc|java|javac|tsc|deno|bun|unity|git)\s+(-v|--version|version)\s*$/i,
];

function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\r?\n/)
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
  if (context.workspaceRoot && writesOutside(trimmed, context.workspaceRoot, context.cwd ?? context.workspaceRoot)) {
    return { category: 'command', risk: 'dangerous', reason: 'writes outside the workspace' };
  }
  if (GIT_WRITE.test(trimmed)) return { category: 'git', risk: 'normal', reason: 'changes git state' };

  const parts = segments(trimmed);
  // A pipeline is safe only if every stage is safe (e.g. `git log | head`).
  const stages = parts.flatMap((p) => p.split('|').map((s) => s.trim())).filter(Boolean);
  const hasRedirect = /(^|[^2])>{1,2}(?!&)/.test(trimmed.replace(/2>&1|2>\s*\$null|2>\s*\/dev\/null|>\s*\$null|>\s*\/dev\/null/gi, ''));
  if (!hasRedirect && stages.length > 0 && stages.every((s) => SAFE_PREFIXES.some((re) => re.test(s)))) {
    return { category: 'command', risk: 'safe' };
  }
  return { category: 'command', risk: 'normal' };
}

/** A file-writing command that names a path outside the workspace (absolute, home-relative or ../..). */
function writesOutside(command: string, root: string, cwd: string): boolean {
  const redirectTargets = [...command.matchAll(/(^|[^2&])>{1,2}\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g)].map((m) => m[2].replace(/^["']|["']$/g, ''));
  const hasWriteVerb = WRITE_VERBS.test(command);
  if (!hasWriteVerb && !redirectTargets.some((t) => !HARMLESS_TARGET.test(t))) return false;
  if (hasWriteVerb && HOME_REF.test(command)) return true;
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
