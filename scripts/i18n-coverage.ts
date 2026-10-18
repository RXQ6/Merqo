import ts from 'typescript';

/** Static translation calls only. Dynamic keys and hardcoded UI text require separate review. */
export function translationKeys(source: string, filename: string): { keys: Set<string>; dynamic: number } {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, filename.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const functions = new Set<string>(), hooks = new Set<string>(), instances = new Set<string>(), keys = new Set<string>();
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const module = node.moduleSpecifier.text;
    if (!/i18n/.test(module)) continue;
    if (node.importClause?.name) instances.add(node.importClause.name.text);
    const imports = node.importClause?.namedBindings;
    if (imports && ts.isNamedImports(imports)) for (const item of imports.elements) {
      const original = item.propertyName?.text ?? item.name.text;
      if (original === 'useTranslation') hooks.add(item.name.text);
      if (original === 't') functions.add(item.name.text);
      if (original === 'i18n') instances.add(item.name.text);
    }
  }
  const bind = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) && hooks.has(node.initializer.expression.text)) {
      for (const element of node.name.elements) if ((element.propertyName?.getText(ast) ?? element.name.getText(ast)) === 't' && ts.isIdentifier(element.name)) functions.add(element.name.text);
    }
    ts.forEachChild(node, bind);
  };
  bind(ast); let dynamic = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const translation = ts.isIdentifier(callee) ? functions.has(callee.text) : ts.isPropertyAccessExpression(callee) && callee.name.text === 't' && ts.isIdentifier(callee.expression) && instances.has(callee.expression.text);
      if (translation) {
        const key = node.arguments[0];
        if (key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key))) keys.add(key.text);
        else dynamic++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); return { keys, dynamic };
}

export function hasTranslation(key: string, locale: Record<string, unknown>): boolean {
  return typeof locale[key] === 'string' || (typeof locale[`${key}_one`] === 'string' && typeof locale[`${key}_other`] === 'string');
}
