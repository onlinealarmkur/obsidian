import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const sourceRoot = new URL("../src/", import.meta.url);
const directTextMethods = new Set(["setName", "setDesc", "setTitle", "setText"]);
const domCreationMethods = new Set(["createEl", "createDiv", "createSpan"]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "i18n" ? [] : sourceFiles(path);
    return extname(entry.name) === ".ts" ? [path] : [];
  });
}

function productionSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSourceFiles(path);
    return extname(entry.name) === ".ts" ? [path] : [];
  });
}

function methodName(expression) {
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : undefined;
}

function staticWords(expression) {
  if (ts.isStringLiteralLike(expression)) return /[\p{L}]{2}/u.test(expression.text) ? expression.text : undefined;
  if (!ts.isTemplateExpression(expression) && !ts.isNoSubstitutionTemplateLiteral(expression)) return undefined;
  const text = expression.getText().replaceAll(/\$\{[^}]*\}/g, "");
  return /[\p{L}]{2}/u.test(text) ? text : undefined;
}

function objectProperty(object, name) {
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  return object.properties.find((property) =>
    ts.isPropertyAssignment(property)
    && ((ts.isIdentifier(property.name) && property.name.text === name)
      || (ts.isStringLiteral(property.name) && property.name.text === name))
  );
}

function inspectSource(path, sourceText) {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];
  const report = (node, text) => {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push(`${relative(new URL(root).pathname, path)}:${location.line + 1}: ${text}`);
  };
  const inspectExpression = (expression) => {
    if (expression === undefined) return;
    const text = staticWords(expression);
    if (text !== undefined) report(expression, text);
  };
  const visit = (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)
      && (node.expression.text === "Notice" || node.expression.text === "Notification")) {
      inspectExpression(node.arguments?.[0]);
    }
    if (ts.isCallExpression(node)) {
      const method = methodName(node.expression);
      if (method !== undefined && directTextMethods.has(method)) inspectExpression(node.arguments[0]);
      if (method === "addRibbonIcon") inspectExpression(node.arguments[1]);
      if (method === "addCommand") {
        const name = objectProperty(node.arguments[0], "name");
        if (name !== undefined && ts.isPropertyAssignment(name)) inspectExpression(name.initializer);
      }
      if (method !== undefined && domCreationMethods.has(method)) {
        const options = method === "createEl" ? node.arguments[1] : node.arguments[0];
        const text = options === undefined ? undefined : objectProperty(options, "text");
        if (text !== undefined && ts.isPropertyAssignment(text)) inspectExpression(text.initializer);
        const attr = options === undefined ? undefined : objectProperty(options, "attr");
        if (attr !== undefined && ts.isPropertyAssignment(attr) && ts.isObjectLiteralExpression(attr.initializer)) {
          for (const attribute of ["aria-label", "title"]) {
            const property = objectProperty(attr.initializer, attribute);
            if (property !== undefined && ts.isPropertyAssignment(property)) inspectExpression(property.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

function inspectLocalizationDependencies(path, sourceText) {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = [];
  const sourcePath = relative(new URL(root).pathname, path);
  const isI18nModule = sourcePath === "src/i18n/index.ts";
  const report = (node, text) => {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push(`${sourcePath}:${location.line + 1}: ${text}`);
  };
  const visit = (node) => {
    if (!isI18nModule && ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined
      && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const specifier of node.importClause.namedBindings.elements) {
        const importedName = specifier.propertyName?.text ?? specifier.name.text;
        if (importedName === "EN_I18N") report(specifier, "imports EN_I18N");
      }
    }
    if (ts.isParameter(node) && node.initializer !== undefined && node.type !== undefined
      && /\bI18n\b/u.test(node.type.getText(source))) {
      report(node, "I18n parameter has an initializer");
    }
    if (!isI18nModule && ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && node.expression.text === "createI18n" && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === "en") {
      report(node, "creates an English localization dependency");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

describe("localization boundaries", () => {
  it("keeps direct prose out of known user-facing sinks", () => {
    const findings = sourceFiles(new URL(sourceRoot).pathname)
      .flatMap((path) => inspectSource(path, readFileSync(path, "utf8")));
    expect(findings).toEqual([]);
  });

  it("detects newly hardcoded notices, settings, commands, and DOM text", () => {
    const sample = `
      new Notice("Hardcoded notice");
      setting.setName("Hardcoded setting");
      plugin.addCommand({ id: "bad", name: "Hardcoded command" });
      parent.createEl("p", { text: "Hardcoded paragraph" });
    `;
    expect(inspectSource("/tmp/localization-boundary-sample.ts", sample)).toHaveLength(4);
  });

  it("requires explicit localization dependencies throughout production source", () => {
    const findings = productionSourceFiles(new URL(sourceRoot).pathname)
      .flatMap((path) => inspectLocalizationDependencies(path, readFileSync(path, "utf8")));
    expect(findings).toEqual([]);
  });

  it("detects implicit English imports, defaults, and construction", () => {
    const sample = `
      import { EN_I18N } from "./i18n";
      function render(i18n: I18n = EN_I18N) {}
      const locale = createI18n("en");
    `;
    expect(inspectLocalizationDependencies("/tmp/localization-dependency-sample.ts", sample)).toHaveLength(3);
  });
});
