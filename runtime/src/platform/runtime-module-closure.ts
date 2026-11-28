/**
The import closure of the Runtime module manifest.

The installer copies exactly the modules `RUNTIME_MODULES` lists, so a module
the list omits is simply absent from the installed tree, and nothing notices
until a service imports it at startup. This reads every listed module's
relative imports with the TypeScript parser and reports the ones the
manifest does not list, so a gap fails the install before anything is
published instead of after a service crash-loops.
*/
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";

const PATH_ORDER = new Intl.Collator("en");

/**
The repository-relative modules a module's source imports at run time by a
relative specifier: static imports and re-exports that are not type-only, and
dynamic `import()` calls with a literal specifier.
*/
export function relativeImportsFromSource(
  modulePath: string,
  source: string
): string[] {
  const file = ts.createSourceFile(
    modulePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const directory = path.dirname(modulePath);
  const imports: string[] = [];
  const addRelativeSpecifier = (specifier: ts.Expression | undefined): void => {
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      specifier.text.startsWith(".")
    ) {
      imports.push(path.normalize(path.join(directory, specifier.text)));
    }
  };

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!statement.importClause?.isTypeOnly)
        addRelativeSpecifier(statement.moduleSpecifier);
      continue;
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      addRelativeSpecifier(statement.moduleSpecifier);
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1
    ) {
      addRelativeSpecifier(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

/**
Every relative import reachable from the listed TypeScript modules that the
list itself does not contain, as `"<missing> (imported by <module>)"`,
sorted. Empty when the manifest is closed.
*/
export function runtimeManifestGaps(
  repositoryRoot: string,
  modules: readonly string[]
): string[] {
  const listed = new Set(modules);
  const pending = modules.filter((entry) => entry.endsWith(".ts"));
  const visited = new Set<string>();
  const gaps: string[] = [];
  while (pending.length > 0) {
    const modulePath = pending.pop()!;
    if (visited.has(modulePath)) continue;
    visited.add(modulePath);
    const source = readFileSync(path.join(repositoryRoot, modulePath), "utf8");
    for (const target of relativeImportsFromSource(modulePath, source)) {
      if (!listed.has(target))
        gaps.push(`${target} (imported by ${modulePath})`);
      if (target.endsWith(".ts")) pending.push(target);
    }
  }
  return gaps.sort(PATH_ORDER.compare);
}
