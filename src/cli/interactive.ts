import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CommandContext {
  sdk: SdkLike;
  out: (line: string) => void;
  history: HistoryStore;
}

export interface SdkLike {
  [method: string]: (...args: any[]) => any;
}

export interface Command {
  name: string;
  description: string;
  usage?: string;
  run: (args: string[], ctx: CommandContext) => Promise<void> | void;
}

export interface HistoryStore {
  add: (line: string) => void;
  all: () => string[];
  clear: () => void;
}

const HISTORY_LIMIT = 500;

export function createHistory(filePath?: string): HistoryStore {
  const file = filePath || path.join(os.homedir(), '.sdk-cli-history');
  let entries: string[] = [];
  try {
    if (fs.existsSync(file)) {
      entries = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
    }
  } catch {
    entries = [];
  }

  const persist = () => {
    try {
      fs.writeFileSync(file, entries.join('\n'), 'utf8');
    } catch {
      // history persistence is best-effort
    }
  };

  return {
    add(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (entries[entries.length - 1] === trimmed) return;
      entries.push(trimmed);
      if (entries.length > HISTORY_LIMIT) {
        entries = entries.slice(entries.length - HISTORY_LIMIT);
      }
      persist();
    },
    all() {
      return entries.slice();
    },
    clear() {
      entries = [];
      persist();
    },
  };
}

export function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function buildCommands(): Command[] {
  return [
    {
      name: 'help',
      description: 'Show available commands',
      usage: 'help [command]',
      run(args, ctx) {
        const commands = buildCommands();
        if (args.length > 0) {
          const cmd = commands.find((c) => c.name === args[0]);
          if (!cmd) {
            ctx.out(`Unknown command: ${args[0]}`);
            return;
          }
          ctx.out(`${cmd.name} - ${cmd.description}`);
          if (cmd.usage) ctx.out(`Usage: ${cmd.usage}`);
          return;
        }
        ctx.out('Available commands:');
        for (const cmd of commands) {
          ctx.out(`  ${cmd.name.padEnd(12)} ${cmd.description}`);
        }
      },
    },
    {
      name: 'call',
      description: 'Invoke an SDK method: call <method> [jsonArgs]',
      usage: 'call <method> [jsonArgs]',
      async run(args, ctx) {
        if (args.length === 0) {
          ctx.out('Usage: call <method> [jsonArgs]');
          return;
        }
        const [method, rawArgs] = args as [string, string | undefined];
        const fn = ctx.sdk[method];
        if (typeof fn !== 'function') {
          ctx.out(`Unknown SDK method: ${method}`);
          return;
        }
        let callArgs: any[] = [];
        if (rawArgs) {
          try {
            const parsed = JSON.parse(rawArgs);
            callArgs = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            ctx.out(`Invalid JSON arguments: ${rawArgs}`);
            return;
          }
        }
        try {
          const result = await fn.apply(ctx.sdk, callArgs);
          ctx.out(formatValue(result));
        } catch (err) {
          ctx.out(`Error: ${(err as Error).message}`);
        }
      },
    },
    {
      name: 'methods',
      description: 'List available SDK methods',
      run(_args, ctx) {
        const names = Object.keys(ctx.sdk).filter(
          (k) => typeof ctx.sdk[k] === 'function'
        );
        if (names.length === 0) {
          ctx.out('No SDK methods available.');
          return;
        }
        for (const name of names) ctx.out(`  ${name}`);
      },
    },
    {
      name: 'history',
      description: 'Show command history',
      usage: 'history [clear]',
      run(args, ctx) {
        if (args[0] === 'clear') {
          ctx.history.clear();
          ctx.out('History cleared.');
          return;
        }
        const entries = ctx.history.all();
        if (entries.length === 0) {
          ctx.out('No history.');
          return;
        }
        entries.forEach((entry, i) => ctx.out(`${String(i + 1).padStart(4)}  ${entry}`));
      },
    },
    {
      name: 'exit',
      description: 'Exit interactive mode',
      run(_args, ctx) {
        ctx.out('Goodbye.');
        process.exit(0);
      },
    },
  ];
}

export async function dispatch(
  input: string,
  commands: Command[],
  ctx: CommandContext
): Promise<void> {
  const tokens = tokenize(input);
  if (tokens.length === 0) return;
  const [name, ...args] = tokens;
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    ctx.out(`Unknown command: ${name}. Type 'help' for available commands.`);
    return;
  }
  await cmd.run(args, ctx);
}

export interface InteractiveOptions {
  sdk: SdkLike;
  out?: (line: string) => void;
  historyPath?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function startInteractive(options: InteractiveOptions): Promise<void> {
  const out = options.out || ((line: string) => process.stdout.write(line + '\n'));
  const history = createHistory(options.historyPath);
  const commands = buildCommands();
  const ctx: CommandContext = { sdk: options.sdk, out, history };

  const rl = readline.createInterface({
    input: options.input || process.stdin,
    output: options.output || process.stdout,
    prompt: 'sdk> ',
    history: history.all().slice().reverse(),
    historySize: HISTORY_LIMIT,
    terminal: true,
  });

  out('SDK interactive mode. Type "help" for commands, "exit" to quit.');
  rl.prompt();

  return new Promise<void>((resolve) => {
    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (trimmed) history.add(trimmed);
      try {
        await dispatch(trimmed, commands, ctx);
      } catch (err) {
        out(`Error: ${(err as Error).message}`);
      }
      rl.prompt();
    });
    rl.on('close', () => {
      out('Goodbye.');
      resolve();
    });
  });
}
