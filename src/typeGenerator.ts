/**
 * Minimal TypeScript type generator from JSON-schema-like definitions.
 */

export interface SchemaNode {
  type?: "string" | "number" | "integer" | "boolean" | "null" | "array" | "object";
  enum?: Array<string | number | boolean>;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  oneOf?: SchemaNode[];
  description?: string;
}

export type ExportFormat = "ts" | "dts" | "json";

export interface TypeGeneratorOptions {
  /** Export format (default "ts"). */
  format?: ExportFormat;
  /** Use `interface` for object roots instead of `type` (default true). */
  useInterfaces?: boolean;
  /** Custom rename of generated type names. */
  nameTransform?: (name: string) => string;
  /** Emit JSDoc comments from descriptions (default true). */
  comments?: boolean;
}

export interface GenerationRecord {
  name: string;
  format: ExportFormat;
  at: number;
}

export function schemaToType(node: SchemaNode): string {
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (node.oneOf) return node.oneOf.map(schemaToType).join(" | ");
  switch (node.type) {
    case "integer":
    case "number":
      return "number";
    case "string":
    case "boolean":
    case "null":
      return node.type;
    case "array":
      return `Array<${node.items ? schemaToType(node.items) : "unknown"}>`;
    case "object": {
      const props = Object.entries(node.properties ?? {});
      if (props.length === 0) return "Record<string, unknown>";
      const req = new Set(node.required ?? []);
      return `{ ${props
        .map(([k, v]) => `${JSON.stringify(k)}${req.has(k) ? "" : "?"}: ${schemaToType(v)};`)
        .join(" ")} }`;
    }
    default:
      return "unknown";
  }
}

export class TypeGenerator {
  private history: GenerationRecord[] = [];

  constructor(private readonly defaults: TypeGeneratorOptions = {}) {}

  generate(name: string, schema: SchemaNode, options: TypeGeneratorOptions = {}): string {
    const o = { format: "ts" as ExportFormat, useInterfaces: true, comments: true, ...this.defaults, ...options };
    const typeName = o.nameTransform ? o.nameTransform(name) : name;
    let out: string;
    if (o.format === "json") {
      out = JSON.stringify({ name: typeName, type: schemaToType(schema) });
    } else {
      const doc = o.comments && schema.description ? `/** ${schema.description} */\n` : "";
      const body = schemaToType(schema);
      const decl =
        o.useInterfaces && schema.type === "object" && schema.properties
          ? `interface ${typeName} ${body}`
          : `type ${typeName} = ${body};`;
      out = `${doc}${o.format === "dts" ? "export declare" : "export"} ${decl}\n`;
    }
    this.history.push({ name: typeName, format: o.format, at: Date.now() });
    return out;
  }

  getHistory(): GenerationRecord[] {
    return [...this.history];
  }
}
