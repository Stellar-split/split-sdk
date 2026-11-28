import { Project, SourceFile, Type, Symbol, SyntaxKind, FunctionDeclaration, MethodSignature, PropertySignature, InterfaceDeclaration, TypeAliasDeclaration, ClassDeclaration } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

export interface Change {
  type: "removed" | "changed_signature" | "renamed_type" | "added_required_param";
  name: string;
  description: string;
  beforeSnippet?: string;
  afterSnippet?: string;
}

export function detectBreakingChanges(fromFiles: string[], toFiles: string[]): Change[] {
  const changes: Change[] = [];
  
  const fromProject = new Project();
  const toProject = new Project();
  
  fromProject.addSourceFilesAtPaths(fromFiles);
  toProject.addSourceFilesAtPaths(toFiles);

  const fromExports = getExports(fromProject);
  const toExports = getExports(toProject);

  // Compare exports
  for (const [name, fromNode] of fromExports.entries()) {
    const toNode = toExports.get(name);
    
    if (!toNode) {
      changes.push({
        type: "removed",
        name,
        description: `Export \`${name}\` was removed.`,
        beforeSnippet: fromNode.getText(),
      });
      continue;
    }

    if (fromNode.getKind() === SyntaxKind.FunctionDeclaration && toNode.getKind() === SyntaxKind.FunctionDeclaration) {
      compareFunctions(name, fromNode as FunctionDeclaration, toNode as FunctionDeclaration, changes);
    } else if (fromNode.getKind() === SyntaxKind.InterfaceDeclaration && toNode.getKind() === SyntaxKind.InterfaceDeclaration) {
      compareInterfaces(name, fromNode as InterfaceDeclaration, toNode as InterfaceDeclaration, changes);
    } else if (fromNode.getKind() !== toNode.getKind()) {
      changes.push({
        type: "renamed_type", // using this as broad type changed/renamed
        name,
        description: `Export \`${name}\` changed its type/kind.`,
        beforeSnippet: fromNode.getText(),
        afterSnippet: toNode.getText()
      });
    }
  }

  return changes;
}

function getExports(project: Project) {
  const exports = new Map<string, any>();
  for (const sourceFile of project.getSourceFiles()) {
    for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
      if (declarations.length > 0) {
        exports.set(name, declarations[0]);
      }
    }
  }
  return exports;
}

function compareFunctions(name: string, fromFn: FunctionDeclaration, toFn: FunctionDeclaration, changes: Change[]) {
  const fromParams = fromFn.getParameters();
  const toParams = toFn.getParameters();

  let hasBreaking = false;
  let description = "";

  if (fromParams.length > toParams.length) {
    // If the new signature has fewer parameters, it's breaking if they were required? Actually removing a param is breaking if the caller expects to pass it and it fails, but usually TS complains. Let's count it as changed signature.
    hasBreaking = true;
    description = `Method signature changed for \`${name}\`: parameters were removed.`;
  }

  for (let i = 0; i < toParams.length; i++) {
    const toParam = toParams[i]!;
    const fromParam = fromParams[i];

    if (!fromParam) {
      if (!toParam.isOptional() && !toParam.hasInitializer()) {
        changes.push({
          type: "added_required_param",
          name,
          description: `Added required parameter \`${toParam.getName()}\` to \`${name}\`.`,
          beforeSnippet: fromFn.getText(),
          afterSnippet: toFn.getText()
        });
      }
    } else {
      // compare types if we wanted to be rigorous, but for now we look for added required params
    }
  }

  if (hasBreaking) {
    changes.push({
      type: "changed_signature",
      name,
      description,
      beforeSnippet: fromFn.getText(),
      afterSnippet: toFn.getText()
    });
  }
}

function compareInterfaces(name: string, fromInt: InterfaceDeclaration, toInt: InterfaceDeclaration, changes: Change[]) {
  const fromProps = fromInt.getProperties();
  const toProps = toInt.getProperties();

  for (const fromProp of fromProps) {
    const propName = fromProp.getName();
    const toProp = toInt.getProperty(propName);

    if (!toProp) {
      changes.push({
        type: "removed",
        name: `${name}.${propName}`,
        description: `Property \`${propName}\` was removed from \`${name}\`.`,
        beforeSnippet: fromProp.getText(),
      });
    }
  }

  const fromMethods = fromInt.getMethods();
  const toMethods = toInt.getMethods();

  for (const fromMethod of fromMethods) {
    const methodName = fromMethod.getName();
    const toMethod = toInt.getMethod(methodName);

    if (!toMethod) {
      changes.push({
        type: "removed",
        name: `${name}.${methodName}`,
        description: `Method \`${methodName}\` was removed from \`${name}\`.`,
        beforeSnippet: fromMethod.getText(),
      });
    } else {
      const fromParams = fromMethod.getParameters();
      const toParams = toMethod.getParameters();
      for (let i = 0; i < toParams.length; i++) {
        if (!fromParams[i] && !toParams[i]!.isOptional()) {
           changes.push({
             type: "added_required_param",
             name: `${name}.${methodName}`,
             description: `Added required parameter \`${toParams[i]!.getName()}\` to \`${name}.${methodName}\`.`,
             beforeSnippet: fromMethod.getText(),
             afterSnippet: toMethod.getText()
           });
        }
      }
    }
  }
}

export function generateMarkdown(changes: Change[]): string {
  if (changes.length === 0) {
    return "# Migration Guide\n\nNo breaking changes detected.\n";
  }

  let md = "# Migration Guide\n\nWe detected breaking changes. Here is how to migrate:\n\n";

  for (const change of changes) {
    md += `## \`${change.name}\` (${change.type})\n\n`;
    md += `${change.description}\n\n`;
    if (change.beforeSnippet) {
      md += `**Before:**\n\`\`\`typescript\n${change.beforeSnippet}\n\`\`\`\n\n`;
    }
    if (change.afterSnippet) {
      md += `**After:**\n\`\`\`typescript\n${change.afterSnippet}\n\`\`\`\n\n`;
    }
  }

  return md;
}
