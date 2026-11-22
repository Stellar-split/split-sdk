/**
 * API Reference Documentation Generator (#1197)
 *
 * Parses JSDoc-style comments from TypeScript source text, builds a
 * navigation tree, implements search, generates markdown output, and
 * emits a versioned DocManifest.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Supported JSDoc tag names. */
export type DocTagName = 'param' | 'returns' | 'example' | 'deprecated' | 'since' | 'throws' | 'see';

/** A single parsed JSDoc tag. */
export interface DocTag {
  tag: DocTagName | string;
  name?: string;
  description: string;
}

/** A parameter extracted from a @param tag. */
export interface DocParam {
  name: string;
  type?: string;
  description: string;
  optional: boolean;
}

/** Kinds of documented entries. */
export type DocEntryKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'module' | 'method' | 'property';

/**
 * A single parsed documentation entry representing a module, class,
 * function, interface, or other exportable symbol.
 */
export interface DocEntry {
  /** Unique identifier — typically the fully-qualified symbol name. */
  id: string;
  /** Display name. */
  name: string;
  /** Module or category the entry belongs to. */
  module: string;
  /** Kind of the entry. */
  kind: DocEntryKind;
  /** Main description extracted from the JSDoc comment. */
  description: string;
  /** Parsed @param tags. */
  params: DocParam[];
  /** Text from the @returns tag. */
  returns?: string;
  /** Code examples from @example tags. */
  examples: string[];
  /** Whether the entry is marked @deprecated. */
  deprecated: boolean;
  /** Deprecation message, if any. */
  deprecationMessage?: string;
  /** Version in which this entry was introduced (@since). */
  since?: string;
  /** Raw tags not handled above. */
  tags: DocTag[];
  /** Source file path (relative). */
  sourceFile?: string;
  /** Line number in the source file. */
  line?: number;
}

/** A node in the navigation tree. */
export interface NavNode {
  /** Display label. */
  label: string;
  /** Unique key (usually the module name). */
  key: string;
  /** Child nodes. */
  children: NavNode[];
  /** Entry IDs at this node. */
  entryIds: string[];
}

/** Full documentation manifest emitted by the generator. */
export interface DocManifest {
  /** SDK version this documentation was generated for. */
  version: string;
  /** ISO timestamp of generation. */
  generatedAt: string;
  /** All parsed entries, keyed by id. */
  entries: Record<string, DocEntry>;
  /** Root navigation node. */
  navigation: NavNode;
  /** Flat sorted list of all entry ids. */
  index: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Strip leading `*` characters and whitespace from a JSDoc comment body. */
function stripJsDocAsterisks(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
    .join('\n')
    .trim();
}

/** Parse a raw `@param` tag value such as `{string} name - Description`. */
function parseParamTag(value: string): DocParam {
  // Matches optional marker, type, name, and description.
  const optionalBracketRe = /^\[([^\]]+)\]\s*(.*)/;
  const typedRe = /^\{([^}]+)\}\s*(.*)/;

  let rest = value.trim();
  let type: string | undefined;

  const typedMatch = typedRe.exec(rest);
  if (typedMatch) {
    type = typedMatch[1] ?? undefined;
    rest = (typedMatch[2] ?? '').trim();
  }

  let optional = false;
  const optMatch = optionalBracketRe.exec(rest);
  if (optMatch) {
    optional = true;
    rest = (optMatch[1] ?? '') + ' ' + (optMatch[2] ?? '');
    rest = rest.trim();
  }

  // Split on first whitespace to get name vs description.
  const spaceIdx = rest.search(/\s/);
  let name: string;
  let description: string;
  if (spaceIdx === -1) {
    name = rest;
    description = '';
  } else {
    name = rest.slice(0, spaceIdx);
    description = rest.slice(spaceIdx + 1).replace(/^[-–]\s*/, '').trim();
  }

  return { name, type, description, optional };
}

/** Extract all JSDoc block comment contents from a TypeScript source string. */
function extractJsDocBlocks(source: string): Array<{ comment: string; afterText: string }> {
  const results: Array<{ comment: string; afterText: string }> = [];
  const docCommentRe = /\/\*\*([\s\S]*?)\*\/([\s\S]*?)(?=\/\*\*|$)/g;
  let match: RegExpExecArray | null;
  while ((match = docCommentRe.exec(source)) !== null) {
    const comment = stripJsDocAsterisks(match[1] ?? '');
    const afterText = (match[2] ?? '').trim();
    results.push({ comment, afterText });
  }
  return results;
}

/** Guess the entry kind from the token immediately following the comment. */
function guessKind(afterText: string): DocEntryKind {
  const first = afterText.split(/[\s({]/)[0] ?? '';
  if (first === 'class') return 'class';
  if (first === 'interface') return 'interface';
  if (first === 'type') return 'type';
  if (first === 'function' || first === 'async') return 'function';
  if (first === 'export' || first === 'const' || first === 'let' || first === 'var') {
    if (/=\s*(async\s+)?function|=\s*\(|=>\s*{/.test(afterText)) return 'function';
    return 'variable';
  }
  return 'function';
}

/** Extract the symbol name from the line following the comment. */
function extractName(afterText: string): string | undefined {
  // Try `export function Foo`, `export class Foo`, `const Foo`, `interface Foo`, `type Foo`
  const patterns = [
    /(?:export\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function|interface|type|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
    /^([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<:=]/,
  ];
  for (const re of patterns) {
    const m = re.exec(afterText);
    if (m?.[1]) return m[1] as string;
  }
  return undefined;
}

/** Parse a single JSDoc comment string into tags and description. */
function parseJsDoc(comment: string): {
  description: string;
  params: DocParam[];
  returns: string | undefined;
  examples: string[];
  deprecated: boolean;
  deprecationMessage: string | undefined;
  since: string | undefined;
  tags: DocTag[];
} {
  const lines = comment.split('\n');
  const descriptionLines: string[] = [];
  const params: DocParam[] = [];
  const examples: string[] = [];
  const tags: DocTag[] = [];
  let returns: string | undefined;
  let deprecated = false;
  let deprecationMessage: string | undefined;
  let since: string | undefined;

  // State machine: 'desc' | 'tag'
  let state: 'desc' | 'tag' = 'desc';
  let currentTag: string | null = null;
  let currentTagValue: string[] = [];

  function flushTag(): void {
    if (!currentTag) return;
    const value = currentTagValue.join('\n').trim();
    switch (currentTag) {
      case 'param':
        params.push(parseParamTag(value));
        break;
      case 'returns':
      case 'return':
        returns = value;
        break;
      case 'example':
        examples.push(value);
        break;
      case 'deprecated':
        deprecated = true;
        deprecationMessage = value || undefined;
        break;
      case 'since':
        since = value;
        break;
      default:
        tags.push({ tag: currentTag, description: value });
    }
    currentTag = null;
    currentTagValue = [];
  }

  for (const line of lines) {
    const tagMatch = /^@([a-zA-Z]+)\s*(.*)/.exec(line.trimStart());
    if (tagMatch) {
      flushTag();
      state = 'tag';
      currentTag = tagMatch[1] ?? '';
      currentTagValue = [(tagMatch[2] ?? '').trim()];
    } else if (state === 'tag') {
      currentTagValue.push(line);
    } else {
      descriptionLines.push(line);
    }
  }
  flushTag();

  return {
    description: descriptionLines.join('\n').trim(),
    params,
    returns,
    examples,
    deprecated,
    deprecationMessage,
    since,
    tags,
  };
}

// ---------------------------------------------------------------------------
// ApiDocGenerator
// ---------------------------------------------------------------------------

/** Options for constructing an ApiDocGenerator. */
export interface ApiDocGeneratorOptions {
  /** SDK version string to embed in the manifest. */
  version: string;
  /**
   * Map of module name → source text. If you want to supply file paths,
   * pass them as keys and the file text as values.
   */
  sources: Record<string, string>;
  /**
   * Optional category grouping. Maps module names to category labels.
   * Modules without an entry are grouped under "General".
   */
  categories?: Record<string, string>;
}

/**
 * Generates API reference documentation from TypeScript source text.
 *
 * @example
 * ```ts
 * const generator = new ApiDocGenerator({
 *   version: '1.0.0',
 *   sources: { 'client': sourceText },
 * });
 * const manifest = generator.generateManifest();
 * ```
 */
export class ApiDocGenerator {
  private readonly version: string;
  private readonly sources: Record<string, string>;
  private readonly categories: Record<string, string>;
  private entries: Map<string, DocEntry> = new Map();

  constructor(options: ApiDocGeneratorOptions) {
    this.version = options.version;
    this.sources = options.sources;
    this.categories = options.categories ?? {};
  }

  // -------------------------------------------------------------------------
  // Parsing
  // -------------------------------------------------------------------------

  /**
   * Parse all source files and populate the internal entry registry.
   * Called automatically by generateManifest(); call explicitly to
   * inspect entries before generating output.
   */
  parse(): this {
    this.entries = new Map();
    for (const [moduleName, sourceText] of Object.entries(this.sources)) {
      this.parseSource(moduleName, sourceText);
    }
    return this;
  }

  private parseSource(moduleName: string, source: string): void {
    const blocks = extractJsDocBlocks(source);
    for (const { comment, afterText } of blocks) {
      const name = extractName(afterText);
      if (!name) continue;
      const parsed = parseJsDoc(comment);
      const id = `${moduleName}/${name}`;
      const entry: DocEntry = {
        id,
        name,
        module: moduleName,
        kind: guessKind(afterText),
        description: parsed.description,
        params: parsed.params,
        returns: parsed.returns,
        examples: parsed.examples,
        deprecated: parsed.deprecated,
        deprecationMessage: parsed.deprecationMessage,
        since: parsed.since,
        tags: parsed.tags,
        sourceFile: moduleName,
      };
      this.entries.set(id, entry);
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  /**
   * Build a navigation tree grouped by category and module.
   *
   * @returns Root NavNode with children per category, each containing
   *          module nodes that list entry IDs.
   */
  buildNavigation(): NavNode {
    if (this.entries.size === 0) this.parse();

    // Group entries by category → module.
    const categoryMap = new Map<string, Map<string, string[]>>();

    for (const entry of this.entries.values()) {
      const category = this.categories[entry.module] ?? 'General';
      let moduleMap = categoryMap.get(category);
      if (!moduleMap) {
        moduleMap = new Map();
        categoryMap.set(category, moduleMap);
      }
      let ids = moduleMap.get(entry.module);
      if (!ids) {
        ids = [];
        moduleMap.set(entry.module, ids);
      }
      ids.push(entry.id);
    }

    const categoryNodes: NavNode[] = [];
    for (const [categoryLabel, moduleMap] of categoryMap) {
      const moduleNodes: NavNode[] = [];
      for (const [moduleName, entryIds] of moduleMap) {
        moduleNodes.push({
          label: moduleName,
          key: moduleName,
          children: [],
          entryIds,
        });
      }
      moduleNodes.sort((a, b) => a.label.localeCompare(b.label));
      categoryNodes.push({
        label: categoryLabel,
        key: categoryLabel.toLowerCase().replace(/\s+/g, '-'),
        children: moduleNodes,
        entryIds: [],
      });
    }
    categoryNodes.sort((a, b) => a.label.localeCompare(b.label));

    return {
      label: 'API Reference',
      key: 'root',
      children: categoryNodes,
      entryIds: [],
    };
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Search entries by name, description, or tags.
   *
   * @param query - Case-insensitive search string.
   * @returns Matching entries, ordered by relevance (name match first).
   */
  search(query: string): DocEntry[] {
    if (this.entries.size === 0) this.parse();
    const q = query.toLowerCase().trim();
    if (!q) return Array.from(this.entries.values());

    const nameMatches: DocEntry[] = [];
    const descMatches: DocEntry[] = [];
    const tagMatches: DocEntry[] = [];

    for (const entry of this.entries.values()) {
      const inName = entry.name.toLowerCase().includes(q);
      const inDesc = entry.description.toLowerCase().includes(q);
      const inModule = entry.module.toLowerCase().includes(q);
      const inTags = entry.tags.some(
        (t) =>
          t.tag.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          (t.name ?? '').toLowerCase().includes(q),
      );

      if (inName) {
        nameMatches.push(entry);
      } else if (inDesc || inModule) {
        descMatches.push(entry);
      } else if (inTags) {
        tagMatches.push(entry);
      }
    }

    return [...nameMatches, ...descMatches, ...tagMatches];
  }

  // -------------------------------------------------------------------------
  // Markdown generation
  // -------------------------------------------------------------------------

  /**
   * Generate a markdown string for all entries in a single module.
   *
   * @param moduleName - The module key as supplied in sources.
   * @returns Markdown text, or null if the module has no entries.
   */
  generateModuleMarkdown(moduleName: string): string | null {
    if (this.entries.size === 0) this.parse();
    const moduleEntries = Array.from(this.entries.values()).filter((e) => e.module === moduleName);
    if (moduleEntries.length === 0) return null;

    const lines: string[] = [`# ${moduleName}`, ''];

    for (const entry of moduleEntries) {
      lines.push(`## ${entry.name}`);
      lines.push('');
      if (entry.deprecated) {
        lines.push(`> **Deprecated** ${entry.deprecationMessage ?? ''}`);
        lines.push('');
      }
      if (entry.since) {
        lines.push(`*Since: ${entry.since}*`);
        lines.push('');
      }
      if (entry.description) {
        lines.push(entry.description);
        lines.push('');
      }
      if (entry.params.length > 0) {
        lines.push('### Parameters');
        lines.push('');
        lines.push('| Name | Type | Optional | Description |');
        lines.push('|------|------|----------|-------------|');
        for (const p of entry.params) {
          lines.push(`| \`${p.name}\` | ${p.type ? `\`${p.type}\`` : '—'} | ${p.optional ? 'Yes' : 'No'} | ${p.description} |`);
        }
        lines.push('');
      }
      if (entry.returns) {
        lines.push('### Returns');
        lines.push('');
        lines.push(entry.returns);
        lines.push('');
      }
      if (entry.examples.length > 0) {
        lines.push('### Examples');
        lines.push('');
        for (const ex of entry.examples) {
          lines.push('```ts');
          lines.push(ex);
          lines.push('```');
          lines.push('');
        }
      }
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Generate an index markdown page listing all modules and their entries.
   *
   * @returns Markdown text.
   */
  generateIndex(): string {
    if (this.entries.size === 0) this.parse();

    const moduleNames = [...new Set(Array.from(this.entries.values()).map((e) => e.module))].sort();
    const lines: string[] = [
      `# API Reference — v${this.version}`,
      '',
      `> Generated at ${new Date().toISOString()}`,
      '',
    ];

    for (const mod of moduleNames) {
      lines.push(`## ${mod}`);
      lines.push('');
      const modEntries = Array.from(this.entries.values())
        .filter((e) => e.module === mod)
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of modEntries) {
        const deprecatedBadge = entry.deprecated ? ' *(deprecated)*' : '';
        lines.push(`- **${entry.name}**${deprecatedBadge} — ${entry.description.split('\n')[0] ?? ''}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Manifest
  // -------------------------------------------------------------------------

  /**
   * Parse all sources and emit a versioned DocManifest.
   *
   * @returns DocManifest containing all entries, navigation tree, and version info.
   *
   * @example
   * ```ts
   * const manifest = generator.generateManifest();
   * console.log(manifest.version);
   * ```
   */
  generateManifest(): DocManifest {
    this.parse();
    const navigation = this.buildNavigation();
    const entriesRecord: Record<string, DocEntry> = {};
    const index: string[] = [];

    for (const [id, entry] of this.entries) {
      entriesRecord[id] = entry;
      index.push(id);
    }
    index.sort();

    return {
      version: this.version,
      generatedAt: new Date().toISOString(),
      entries: entriesRecord,
      navigation,
      index,
    };
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Return all currently-parsed entries. */
  getEntries(): DocEntry[] {
    if (this.entries.size === 0) this.parse();
    return Array.from(this.entries.values());
  }

  /** Return a single entry by id, or undefined. */
  getEntry(id: string): DocEntry | undefined {
    if (this.entries.size === 0) this.parse();
    return this.entries.get(id);
  }

  /** List the unique module names present in the parsed entries. */
  listModules(): string[] {
    if (this.entries.size === 0) this.parse();
    return [...new Set(Array.from(this.entries.values()).map((e) => e.module))].sort();
  }
}
