import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

interface JSDocTag {
  name: string;
  text: string;
}

interface Export {
  name: string;
  kind: "function" | "class" | "type" | "interface" | "enum" | "const";
  signature: string;
  description: string;
  params: JSDocTag[];
  returns: JSDocTag | null;
  examples: string[];
}

interface DocExample {
  exportName: string;
  source: string;
  code: string;
  expected: string | null;
}

interface ExampleResult {
  example: DocExample;
  passed: boolean;
  error: string | null;
}

function extractJSDocText(text: string): { description: string; params: JSDocTag[]; returns: JSDocTag | null; examples: string[] } {
  const lines = text.split("\n");
  let description = "";
  const params: JSDocTag[] = [];
  let returns: JSDocTag | null = null;
  const examples: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].replace(/^\s*\*\s?/, "").trim();
    if (line.startsWith("@")) break;
    if (line && !line.startsWith("/*") && !line.endsWith("*/")) {
      if (description) description += "\n";
      description += line;
    }
    i++;
  }

  while (i < lines.length) {
    const line = lines[i].replace(/^\s*\*\s?/, "").trim();
    if (line.startsWith("@param")) {
      const match = line.match(/@param\s+(\w+)\s*-?\s*([\s\S]*?)$/);
      if (match) {
        let content = match[2];
        i++;
        while (i < lines.length && !lines[i].match(/^\s*\*\s*@/)) {
          const part = lines[i].replace(/^\s*\*\s?/, "").trim();
          if (part) content += " " + part;
          i++;
        }
        params.push({ name: match[1], text: content.trim() });
        continue;
      }
    } else if (line.startsWith("@returns") || line.startsWith("@return")) {
      const match = line.match(/@returns?\s+([\s\S]*?)$/);
      if (match) {
        let content = match[1];
        i++;
        while (i < lines.length && !lines[i].match(/^\s*\*\s*@/)) {
          const part = lines[i].replace(/^\s*\*\s?/, "").trim();
          if (part) content += " " + part;
          i++;
        }
        returns = { name: "returns", text: content.trim() };
        continue;
      }
    } else if (line.startsWith("@example")) {
      const match = line.match(/@example\s+([\s\S]*?)$/);
      if (match) {
        let content = match[1];
        i++;
        while (i < lines.length && !lines[i].match(/^\s*\*\s*@/)) {
          const part = lines[i].replace(/^\s*\*\s?/, "").trim();
          if (part) content += "\n" + part;
          i++;
        }
        examples.push(content.trim());
        continue;
      }
    }
    i++;
  }

  return { description: description.trim(), params, returns, examples };
}

function extractJSDocFromNode(node: ts.Node | undefined, sourceFile: ts.SourceFile): { description: string; params: JSDocTag[]; returns: JSDocTag | null; examples: string[] } {
  if (!node) return { description: "", params: [], returns: null, examples: [] };
  
  // Get JSDoc using getLeadingCommentRanges from source file text
  const sourceText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const leadingComments = ts.getLeadingCommentRanges(sourceText, nodeStart);
  
  if (!leadingComments || leadingComments.length === 0) {
    return { description: "", params: [], returns: null, examples: [] };
  }
  
  const lastComment = leadingComments[leadingComments.length - 1];
  const commentText = sourceText.substring(lastComment.pos, lastComment.end);
  
  if (!commentText.includes("/**")) {
    return { description: "", params: [], returns: null, examples: [] };
  }
  
  return extractJSDocText(commentText);
}

function getSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  let source = sourceFile.text.substring(start, end);
  const lines = source.split("\n");
  if (lines.length > 5) {
    source = lines.slice(0, 5).join("\n") + " ...";
  }
  return source.trim();
}

interface Declaration {
  node: ts.Node;
  kind: "function" | "class" | "type" | "interface" | "enum" | "const";
}

function findDeclaration(sourceFile: ts.SourceFile, name: string): Declaration | null {
  let result: Declaration | null = null;

  function visit(node: ts.Node): void {
    if (!result) {
      if (ts.isFunctionDeclaration(node) && node.name?.getText() === name) {
        result = { node, kind: "function" };
      } else if (ts.isClassDeclaration(node) && node.name?.getText() === name) {
        result = { node, kind: "class" };
      } else if (ts.isTypeAliasDeclaration(node) && node.name.getText() === name) {
        result = { node, kind: "type" };
      } else if (ts.isInterfaceDeclaration(node) && node.name.getText() === name) {
        result = { node, kind: "interface" };
      } else if (ts.isEnumDeclaration(node) && node.name.getText() === name) {
        result = { node, kind: "enum" };
      } else if (ts.isVariableDeclaration(node) && node.name.getText() === name) {
        result = { node, kind: "const" };
      } else {
        ts.forEachChild(node, visit);
      }
    }
  }

  visit(sourceFile);
  return result;
}

function loadSourceFile(filePath: string): ts.SourceFile {
  const content = readFileSync(filePath, "utf8");
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.ES2020, true);
}

function parseExports(indexContent: string, srcDir: string): Map<string, Export> {
  const exports = new Map<string, Export>();
  const sourceFileCache = new Map<string, ts.SourceFile>();

  function getSourceFile(relativePath: string): ts.SourceFile | null {
    const normalized = relativePath.replace(/\.js$/, ".ts");
    const fullPath = resolve(srcDir, normalized);

    if (sourceFileCache.has(fullPath)) {
      return sourceFileCache.get(fullPath)!;
    }

    try {
      const sf = loadSourceFile(fullPath);
      sourceFileCache.set(fullPath, sf);
      return sf;
    } catch {
      return null;
    }
  }

  // Match: export { name1, name2 as alias } from "./module.js"
  const exportRegex = /export\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g;
  let match;

  while ((match = exportRegex.exec(indexContent)) !== null) {
    const names = match[1].split(",").map((n) => n.trim());
    const fromModule = match[2];

    const moduleSource = getSourceFile(fromModule);
    if (!moduleSource) continue;

    for (const nameSpec of names) {
      const [imported, exported] = nameSpec.includes(" as ") ? nameSpec.split(" as ").map((s) => s.trim()) : [nameSpec, nameSpec];

      const found = findDeclaration(moduleSource, imported);
      if (found) {
        const { description, params, returns, examples } = extractJSDocFromNode(found.node, moduleSource);
        exports.set(exported, {
          name: exported,
          kind: found.kind,
          signature: getSignature(found.node, moduleSource),
          description,
          params,
          returns,
          examples,
        });
      }
    }
  }

  return exports;
}

// Extract runnable code examples from parsed exports. Each @example block may
// contain a fenced code snippet and an optional `// => expected` result line.
function extractExamples(exports: Map<string, Export>): DocExample[] {
  const examples: DocExample[] = [];

  for (const exp of exports.values()) {
    for (const raw of exp.examples) {
      const fenced = raw.match(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/);
      const source = fenced ? fenced[1] : raw;
      const lines = source.split("\n");
      const codeLines: string[] = [];
      let expected: string | null = null;

      for (const line of lines) {
        const resultMatch = line.match(/^\s*\/\/\s*=>\s*(.+)$/);
        if (resultMatch) {
          expected = resultMatch[1].trim();
        } else {
          codeLines.push(line);
        }
      }

      const code = codeLines.join("\n").trim();
      if (!code) continue;

      examples.push({ exportName: exp.name, source: raw, code, expected });
    }
  }

  return examples;
}

// Validate that an example is syntactically valid TypeScript before running it.
function validateExample(example: DocExample): string | null {
  const sf = ts.createSourceFile("example.ts", example.code, ts.ScriptTarget.ES2020, true);
  const diagnostics = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    return `Syntax error in example for ${example.exportName}: ${message}`;
  }
  return null;
}

// Run a single example in an isolated function scope and validate its result.
function runExample(example: DocExample): ExampleResult {
  const syntaxError = validateExample(example);
  if (syntaxError) {
    return { example, passed: false, error: syntaxError };
  }

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`"use strict";\n${example.code}`);
    const result = fn();

    if (example.expected !== null) {
      const actual = typeof result === "undefined" ? "undefined" : JSON.stringify(result);
      const normalizedExpected = example.expected.replace(/^["']|["']$/g, "");
      const normalizedActual = actual.replace(/^["']|["']$/g, "");
      if (normalizedActual !== normalizedExpected) {
        return {
          example,
          passed: false,
          error: `Result mismatch for ${example.exportName}: expected ${example.expected}, got ${actual}`,
        };
      }
    }

    return { example, passed: true, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { example, passed: false, error: `Runtime error in example for ${example.exportName}: ${message}` };
  }
}

function runExamples(examples: DocExample[]): ExampleResult[] {
  return examples.map(runExample);
}

function reportFailures(results: ExampleResult[]): string {
  const failures = results.filter((r) => !r.passed);
  if (failures.length === 0) return "";

  let report = `\nDocumentation example failures (${failures.length}):\n`;
  for (const failure of failures) {
    report += `  - [${failure.example.exportName}] ${failure.error}\n`;
  }
  return report;
}

function renderMarkdown(exports: Export[]): string {
  const sorted = Array.from(exports).sort((a, b) => a.name.localeCompare(b.name));
  let md = "# API Reference\n\n";
  md += `Auto-generated API documentation for @stellar-split/sdk. Total exports: ${sorted.length}\n\n`;
  md += "## Table of Contents\n\n";

  for (const exp of sorted) {
    md += `- [${exp.name}](#${exp.name.toLowerCase()})\n`;
  }
  md += "\n---\n\n";

  for (const exp of sorted) {
    md += `## ${exp.name}\n\n`;
    md += `**Kind:** \`${exp.kind}\`\n\n`;

    if (exp.description) {
      md += `${exp.description}\n\n`;
    }

    md += "### Signature\n\n";
    md += "```typescript\n";
    md += exp.signature + "\n";
    md += "```\n\n";

    if (exp.params.length > 0) {
      md += "### Parameters\n\n";
      md += "| Name | Description |\n";
      md += "|------|-------------|\n";
      for (const param of exp.params) {
        const desc = param.text.replace(/\|/g, "\\|").replace(/\n/g, " ");
        md += `| \`${param.name}\` | ${desc} |\n`;
      }
      md += "\n";
    }

    if (exp.returns) {
      md += "### Returns\n\n";
      md += exp.returns.text + "\n\n";
    }

    if (exp.examples.length > 0) {
      md += "### Examples\n\n";
      for (const example of exp.examples) {
        md += "```typescript\n";
        md += example + "\n";
        md += "```\n\n";
      }
    }
  }

  return md;
}

interface ErrorCodeEntry {
  code: string;
  message: string;
  description: string;
  domain: string;
  retryable: boolean;
}

interface ErrorCodeRegistry {
  codes: Record<string, ErrorCodeEntry>;
  getErrorByCode?: (code: string) => ErrorCodeEntry | undefined;
  getErrorMessage?: (code: string) => string;
}

function loadErrorRegistry(srcDir: string): ErrorCodeRegistry | null {
  const errorsPath = resolve(srcDir, "errors.ts");
  let content: string;
  try {
    content = readFileSync(errorsPath, "utf8");
  } catch {
    return null;
  }

  const sourceFile = ts.createSourceFile(errorsPath, content, ts.ScriptTarget.ES2020, true);
  const registry: ErrorCodeRegistry = { codes: {} };

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText() === "ERROR_CODES" && node.initializer) {
      const init = node.initializer;
      if (ts.isObjectLiteralExpression(init)) {
        for (const prop of init.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = prop.name.getText().replace(/^["']|["']$/g, "");
          const value = prop.initializer;
          if (!ts.isObjectLiteralExpression(value)) continue;
          const entry: ErrorCodeEntry = {
            code: key,
            message: "",
            description: "",
            domain: "",
            retryable: false,
          };
          for (const field of value.properties) {
            if (!ts.isPropertyAssignment(field)) continue;
            const fieldName = field.name.getText().replace(/^["']|["']$/g, "");
            const fieldValue = field.initializer;
            if (ts.isStringLiteral(fieldValue) || ts.isNoSubstitutionTemplateLiteral(fieldValue)) {
              if (fieldName === "message") entry.message = fieldValue.text;
              else if (fieldName === "description") entry.description = fieldValue.text;
              else if (fieldName === "domain") entry.domain = fieldValue.text;
            } else if (fieldValue.kind === ts.SyntaxKind.TrueKeyword) {
              if (fieldName === "retryable") entry.retryable = true;
            } else if (fieldValue.kind === ts.SyntaxKind.FalseKeyword) {
              if (fieldName === "retryable") entry.retryable = false;
            }
          }
          registry.codes[key] = entry;
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return registry;
}

function renderErrorCodesMarkdown(registry: ErrorCodeRegistry): string {
  const entries = Object.values(registry.codes).sort((a, b) => a.code.localeCompare(b.code));
  let md = "# Error Code Reference\n\n";
  md += "Complete reference of SDK error codes. Each error carries a stable `code`, a human-readable `message`, a `description`, a `domain`, and a `retryable` flag indicating whether the operation may be retried.\n\n";

  md += "## Usage\n\n";
  md += "```typescript\n";
  md += 'import { getErrorByCode, getErrorMessage } from "@stellar-split/sdk";\n\n';
  md += "// Look up full error metadata by code\n";
  md += 'const info = getErrorByCode("SPLIT_001");\n';
  md += "if (info) {\n";
  md += "  console.log(info.message, info.retryable);\n";
  md += "}\n\n";
  md += "// Get just the human-readable message\n";
  md += 'const message = getErrorMessage("SPLIT_001");\n';
  md += "```\n\n";

  md += "## Codes\n\n";
  md += "| Code | Message | Domain | Retryable | Description |\n";
  md += "|------|---------|--------|-----------|-------------|\n";
  for (const entry of entries) {
    const message = entry.message.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const description = entry.description.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const domain = entry.domain.replace(/\|/g, "\\|");
    md += `| \`${entry.code}\` | ${message} | ${domain} | ${entry.retryable ? "yes" : "no"} | ${description} |\n`;
  }
  md += "\n";

  return md;
}

function generateErrorDocs(srcDir: string, outputPath: string): number {
  const registry = loadErrorRegistry(srcDir);
  if (!registry) {
    process.stderr.write("Warning: could not load error registry from src/errors.ts; skipping error code docs.\n");
    return 0;
  }
  const markdown = renderErrorCodesMarkdown(registry);
  writeFileSync(outputPath, markdown, "utf8");
  return Object.keys(registry.codes).length;
}

function main(): void {
  const rootDir = resolve(dirname(new URL(import.meta.url).pathname), "..");
  const srcDir = resolve(rootDir, "src");
  const indexPath = resolve(srcDir, "index.ts");
  const outputPath = resolve(rootDir, "docs", "API.md");
  const errorOutputPath = resolve(rootDir, "docs", "error-codes.md");

  const indexContent = readFileSync(indexPath, "utf8");
  const exports = parseExports(indexContent, srcDir);

  const examples = extractExamples(exports);
  const results = runExamples(examples);
  const failureReport = reportFailures(results);

  if (failureReport) {
    process.stderr.write(failureReport);
    process.exitCode = 1;
  }

  const markdown = renderMarkdown(Array.from(exports.values()));
  writeFileSync(outputPath, markdown, "utf8");

  const errorCodeCount = generateErrorDocs(srcDir, errorOutputPath);

  process.stdout.write(
    `Generated docs for ${exports.size} exports; tested ${results.length} examples (${results.filter((r) => r.passed).length} passed); documented ${errorCodeCount} error codes.\n`,
  );
}

main();
