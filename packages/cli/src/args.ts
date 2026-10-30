import type { PermissionMode } from '@orka/core';

export interface CliArgs {
  /** The first request (interactive) or the only one (--print). */
  prompt?: string;
  /** Answer one request and exit; the reply goes to stdout, progress to stderr. */
  print: boolean;
  provider?: string;
  model?: string;
  mode?: PermissionMode;
  cwd?: string;
  /** Resume the most recent task in this folder. */
  resume: boolean;
  /** "provider[:model]", or false to turn the supervisor off for this session. */
  supervisor?: string | false;
  lang?: string;
  help: boolean;
  version: boolean;
  /** `orka models [provider]`, `orka config`, `orka agents [id]`. */
  command?: 'models' | 'config' | 'agents';
  commandArg?: string;
}

const MODES: PermissionMode[] = ['ask', 'balanced', 'autonomous'];

/** Needs a value: --model x or --model=x. */
const VALUE_FLAGS: Record<string, keyof CliArgs> = {
  '--provider': 'provider',
  '--model': 'model',
  '-m': 'model',
  '--mode': 'mode',
  '--cwd': 'cwd',
  '-C': 'cwd',
  '--supervisor': 'supervisor',
  '--lang': 'lang',
};

export function parseArgs(argv: readonly string[]): CliArgs | { error: string } {
  const args: CliArgs = { print: false, resume: false, help: false, version: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--') {
      words.push(...argv.slice(i + 1));
      break;
    }
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const key = VALUE_FLAGS[flag];
    if (key) {
      const value = eq > 0 ? raw.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') return { error: `${flag} needs a value.` };
      if (key === 'mode' && !MODES.includes(value as PermissionMode)) return { error: `--mode must be one of: ${MODES.join(', ')}.` };
      (args as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    switch (raw) {
      case '-p':
      case '--print':
        args.print = true;
        break;
      case '-y':
      case '--yes':
        args.mode = 'autonomous';
        break;
      case '-c':
      case '--continue':
        args.resume = true;
        break;
      case '--no-supervisor':
        args.supervisor = false;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-v':
      case '--version':
        args.version = true;
        break;
      default:
        if (raw.startsWith('-') && raw.length > 1) return { error: `Unknown option: ${raw}` };
        words.push(raw);
    }
  }
  if ((words[0] === 'models' || words[0] === 'config' || words[0] === 'agents') && words.length <= 2 && !args.print) {
    args.command = words[0];
    args.commandArg = words[1];
  } else if (words.length) {
    args.prompt = words.join(' ');
  }
  if (args.print && !args.prompt) return { error: '--print needs a request, e.g. orka -p "explain src/index.ts".' };
  return args;
}

export const HELP = `Orka - AI coding orchestrator in the terminal

Usage
  orka                       Start a session in this folder
  orka "fix the login bug"   Start with a request
  orka -p "explain main.ts"  Answer one request and exit (reply on stdout)
  orka -c                    Continue the last task in this folder
  orka models [provider]     List the models Orka knows
  orka agents [id]           List the agent CLIs Orka can run as the main agent, and their status
  orka config                Show where the config lives and what is in use

Options
  --provider <id>        claude, openai, gemini, claude-code (opt-in), a custom id from the config,
                         or agent:<id> to make an agent CLI the main agent (see Agent mode)
  -m, --model <id>       Model for the main agent (e.g. claude-sonnet-5-5, gpt-6-astra)
  --mode <m>             ask | balanced (default) | autonomous
  -y, --yes              Same as --mode autonomous (dangerous commands still ask)
  --supervisor <p[:m]>   Supervisor provider and model, e.g. claude:claude-sonnet-5-5
  --no-supervisor        No supervisor for this session
  -C, --cwd <dir>        Work in this folder instead of the current one
  --lang <en|tr>         Language (default: the system language)
  -h, --help, -v, --version

API keys come from the environment only: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
(custom endpoints: "apiKeyEnv" in the config). Claude Code (unofficial, opt-in with
"claudeCode": { "enabled": true } in the config) needs no key: it uses your logged-in claude CLI.

Agent mode: --provider agent:gemini (or agent:codex, agent:copilot, agent:cursor, or
agent:custom:<name> for an agent in "agentClis.custom" in the config) makes an agent CLI you
installed and signed in to yourself the main agent. Orka never reads its sign-in. Orka's
permission rules (and you, where they ask) answer the agent's permission requests, file writes and
commands; every file the agent changes stays reviewable and revertible (/diff, /undo; needs git),
and the Supervisor reviews the final result. "provider" in the config may only name agents in
"agentClis.enabled". In a session, /model agent:<id> switches to one. orka agents shows what is
installed and each agent's terms.

Without a terminal to ask (piped input: scripts, CI), every approval that would ask is declined,
never approved silently; in agent mode that includes the agent's own permission requests.

Once a day Orka asks GitHub in the background whether a newer release is out and mentions it at
the next start; it never downloads anything. Turn this off with "updateCheck": false in the config
or ORKA_NO_UPDATE_CHECK=1.

In a session: /help lists the commands (/new, /diff, /undo, /rewind, /compact, /mode, /model,
/usage, /skills, /freebuff, /exit). Ctrl+C stops the running request; press it twice at the prompt
to leave.`;

export const HELP_TR = `Orka - terminalde AI coding orchestrator

Kullanım
  orka                       Bu klasörde oturum başlat
  orka "login hatasını düzelt"  Bir istekle başlat
  orka -p "main.ts'i açıkla" Tek isteği yanıtla ve çık (yanıt stdout'a)
  orka -c                    Bu klasördeki son göreve devam et
  orka models [provider]     Orka'nın bildiği modeller
  orka agents [id]           Orka'nın ana agent olarak çalıştırabildiği agent CLI'lar ve durumları
  orka config                Config nerede, ne kullanılıyor

Seçenekler
  --provider <id>        claude, openai, gemini, claude-code (isteğe bağlı), config'deki custom id
                         ya da bir agent CLI'ı ana agent yapmak için agent:<id> (bkz. Agent modu)
  -m, --model <id>       Ana agent'ın modeli (ör. claude-sonnet-5-5, gpt-6-astra)
  --mode <m>             ask | balanced (varsayılan) | autonomous
  -y, --yes              --mode autonomous ile aynı (tehlikeli komutlar yine sorar)
  --supervisor <p[:m]>   Supervisor provider ve modeli, ör. claude:claude-sonnet-5-5
  --no-supervisor        Bu oturumda Supervisor yok
  -C, --cwd <klasör>     Bulunulan klasör yerine bu klasörde çalış
  --lang <en|tr>         Dil (varsayılan: sistem dili)
  -h, --help, -v, --version

API key'ler yalnızca ortam değişkenlerinden okunur: ANTHROPIC_API_KEY, OPENAI_API_KEY,
GEMINI_API_KEY (custom endpoint'ler: config'de "apiKeyEnv"). Claude Code (resmi değil, config'de
"claudeCode": { "enabled": true } ile açılır) key istemez: giriş yapılmış claude CLI'ını kullanır.

Agent modu: --provider agent:gemini (ya da agent:codex, agent:copilot, agent:cursor veya config'deki
"agentClis.custom" listesinde bir agent için agent:custom:<ad>) kendiniz kurup giriş yaptığınız bir
agent CLI'ı ana agent yapar. Orka onun oturum bilgilerini asla okumaz. Agent'ın izin isteklerini,
dosya yazmalarını ve komutlarını Orka'nın izin kuralları (ve kuralların sorduğu yerde siz)
yanıtlar; agent'ın değiştirdiği her dosya incelenebilir ve geri alınabilir kalır (/diff, /undo; git
gerekir) ve Supervisor son sonucu inceler. Config'deki "provider" yalnızca "agentClis.enabled"
listesindeki agent'ları seçebilir. Oturumda /model agent:<id> bir agent'a geçer. orka agents neyin
kurulu olduğunu ve her agent'ın koşullarını gösterir.

Soracak bir terminal yoksa (yönlendirilmiş girdi: script'ler, CI), onay isteyen her işlem reddedilir,
asla sessizce onaylanmaz; agent modunda buna agent'ın kendi izin istekleri de dahildir.

Orka günde bir kez arka planda GitHub'a yeni bir sürüm çıkıp çıkmadığını sorar ve varsa bir sonraki
açılışta söyler; hiçbir şey indirmez. Kapatmak için config'de "updateCheck": false ya da
ORKA_NO_UPDATE_CHECK=1.

Oturumda: /help komutları listeler (/new, /diff, /undo, /rewind, /compact, /mode, /model,
/usage, /skills, /freebuff, /exit). Ctrl+C çalışan isteği durdurur; prompt'ta iki kez basınca
çıkar.`;
