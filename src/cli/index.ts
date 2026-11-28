#!/usr/bin/env node
import * as readline from 'readline';

export interface CliCommand {
  name: string;
  description: string;
  usage?: string;
  run: (args: string[], ctx: CliContext) => Promise<void> | void;
}

export interface CliContext {
  history: string[];
  print: (line: string) => void;
  exit: () => void;
}

const commands: CliCommand[] = [];

export function registerCommand(cmd: CliCommand): void {
  commands.push(cmd);
}

export function getCommands(): CliCommand[] {
  return commands.slice();
}

function findCommand(name: string): CliCommand | undefined {
  return commands.find((c) => c.name === name);
}

function formatHelp(): string {
  const lines: string[] = ['Available commands:'];
  const width = commands.reduce((m, c) => Math.max(m, c.name.length), 0);
  for (const c of commands) {
    lines.push(`  ${c.name.padEnd(width)}  ${c.description}`);
  }
  lines.push('');
  lines.push('Type "help <command>" for detailed usage.');
  return lines.join('\n');
}

function formatCommandHelp(cmd: CliCommand): string {
  const lines = [`${cmd.name} - ${cmd.description}`];
  if (cmd.usage) {
    lines.push(`Usage: ${cmd.usage}`);
  }
  return lines.join('\n');
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

async function dispatch(input: string, ctx: CliContext): Promise<void> {
  const trimmed = input.trim();
  if (!trimmed) return;
  ctx.history.push(trimmed);
  const [name, ...args] = tokenize(trimmed) as [string, ...string[]];

  if (name === 'help') {
    if (args.length > 0) {
      const target = findCommand(args[0]!);
      ctx.print(target ? formatCommandHelp(target) : `Unknown command: ${args[0]}`);
    } else {
      ctx.print(formatHelp());
    }
    return;
  }

  if (name === 'history') {
    if (ctx.history.length === 0) {
      ctx.print('(no history)');
    } else {
      ctx.history.forEach((h, i) => ctx.print(`${i + 1}  ${h}`));
    }
    return;
  }

  if (name === 'exit' || name === 'quit') {
    ctx.exit();
    return;
  }

  const cmd = findCommand(name);
  if (!cmd) {
    ctx.print(`Unknown command: ${name}. Type "help" for available commands.`);
    return;
  }

  try {
    await cmd.run(args, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.print(`Error: ${msg}`);
  }
}

function registerBuiltins(): void {
  registerCommand({
    name: 'ping',
    description: 'Check that the SDK CLI is responsive',
    usage: 'ping',
    run: (_args, ctx) => {
      ctx.print('pong');
    },
  });

  registerCommand({
    name: 'echo',
    description: 'Echo the provided arguments',
    usage: 'echo <text...>',
    run: (args, ctx) => {
      ctx.print(args.join(' '));
    },
  });

  registerCommand({
    name: 'version',
    description: 'Print the CLI version',
    usage: 'version',
    run: (_args, ctx) => {
      ctx.print('sdk-cli 1.0.0');
    },
  });
}

registerBuiltins();

export async function runInteractive(): Promise<void> {
  const history: string[] = [];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'sdk> ',
  });

  const ctx: CliContext = {
    history,
    print: (line) => process.stdout.write(`${line}\n`),
    exit: () => rl.close(),
  };

  process.stdout.write('SDK interactive mode. Type "help" for commands, "exit" to quit.\n');
  rl.prompt();

  rl.on('line', async (line) => {
    await dispatch(line, ctx);
    rl.prompt();
  });

  await new Promise<void>((resolve) => rl.on('close', () => resolve()));
}

export async function runOnce(argv: string[]): Promise<void> {
  const history: string[] = [];
  const ctx: CliContext = {
    history,
    print: (line) => process.stdout.write(`${line}\n`),
    exit: () => undefined,
  };
  await dispatch(argv.join(' '), ctx);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.length === 0) {
    await runInteractive();
    return;
  }
  await runOnce(argv);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
