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
      md += `${exp.returns.text}\n\n`;
    }

    if (exp.examples.length > 0) {
      md += "### Examples\n\n";
      for (const example of exp.examples) {
        md += "```typescript\n";
        md += example + "\n";
        md += "```\n\n";
      }
    }

    md += "---\n\n";
  }

  return md;
}

function generate(): void {
  const indexPath = resolve(process.cwd(), "src/index.ts");
  const srcDir = resolve(process.cwd(), "src");

  const indexContent = readFileSync(indexPath, "utf8");
  const exports = parseExports(indexContent, srcDir);
  const markdown = renderMarkdown(Array.from(exports.values()));

  const outputPath = resolve(process.cwd(), "docs/API.md");
  writeFileSync(outputPath, markdown, "utf8");
  console.log(`✓ Generated API documentation: ${outputPath}`);
  console.log(`✓ Documented ${exports.size} exports`);
}

generate();
