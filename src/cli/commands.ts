import * as readline from 'readline';

export interface CommandContext {
  args: string[];
  history: string[];
  print: (line: string) => void;
}

export interface Command {
  name: string;
  description: string;
  usage: string;
  run: (ctx: CommandContext) => Promise<void> | void;
}

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
};

export const formatOutput = (value: unknown): string => formatValue(value);

export class CommandRegistry {
  private commands = new Map<string, Command>();

  register(command: Command): this {
    this.commands.set(command.name, command);
    return this;
  }

  get(name: string): Command | undefined {
    return this.commands.get(name);
  }

  list(): Command[] {
    return Array.from(this.commands.values());
  }

  help(): string {
    const lines = ['Available commands:', ''];
    for (const command of this.list()) {
      lines.push(`  ${command.name.padEnd(12)} ${command.description}`);
      lines.push(`  ${''.padEnd(12)} usage: ${command.usage}`);
    }
    lines.push('');
    lines.push('  help         Show this help message');
    lines.push('  exit         Exit interactive mode');
    return lines.join('\n');
  }
}

export interface CliOptions {
  registry: CommandRegistry;
  print?: (line: string) => void;
}

export class Cli {
  private registry: CommandRegistry;
  private history: string[] = [];
  private print: (line: string) => void;

  constructor(options: CliOptions) {
    this.registry = options.registry;
    this.print = options.print ?? ((line: string) => console.log(line));
  }

  getHistory(): string[] {
    return [...this.history];
  }

  async execute(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }
    this.history.push(trimmed);

    const [name, ...args] = trimmed.split(/\s+/) as [string, ...string[]];

    if (name === 'help') {
      this.print(this.registry.help());
      return;
    }
    if (name === 'history') {
      if (this.history.length === 0) {
        this.print('No history yet.');
        return;
      }
      this.history.forEach((entry, index) => {
        this.print(`${index + 1}  ${entry}`);
      });
      return;
    }

    const command = this.registry.get(name);
    if (!command) {
      this.print(`Unknown command: ${name}. Type "help" for available commands.`);
      return;
    }

    try {
      await command.run({ args, history: this.getHistory(), print: this.print });
    } catch (error) {
      this.print(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async runInteractive(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'sdk> ',
    });

    this.print('Interactive SDK CLI. Type "help" for commands, "exit" to quit.');
    rl.prompt();

    await new Promise<void>((resolve) => {
      rl.on('line', async (line) => {
        const trimmed = line.trim();
        if (trimmed === 'exit' || trimmed === 'quit') {
          rl.close();
          return;
        }
        await this.execute(trimmed);
        rl.prompt();
      });
      rl.on('close', () => resolve());
    });
  }
}

export const createDefaultRegistry = (): CommandRegistry => {
  const registry = new CommandRegistry();

  registry.register({
    name: 'echo',
    description: 'Print the provided arguments',
    usage: 'echo <text...>',
    run: ({ args, print }) => {
      print(args.join(' '));
    },
  });

  registry.register({
    name: 'format',
    description: 'Format a JSON value for display',
    usage: 'format <json>',
    run: ({ args, print }) => {
      const raw = args.join(' ');
      try {
        print(formatOutput(JSON.parse(raw)));
      } catch {
        print(formatOutput(raw));
      }
    },
  });

  return registry;
};

export const main = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  const cli = new Cli({ registry: createDefaultRegistry() });

  if (argv.length === 0) {
    await cli.runInteractive();
    return;
  }

  await cli.execute(argv.join(' '));
};
