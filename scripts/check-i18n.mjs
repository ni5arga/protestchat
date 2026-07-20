import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const supported = ['en', 'hi', 'bn', 'mr', 'te', 'ta'];
const permissionKeys = [
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSLocalNetworkUsageDescription',
];
const failures = [];

const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const plugin = config.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-localization');
const declaredIos = plugin?.[1]?.supportedLocales?.ios ?? [];
const declaredAndroid = plugin?.[1]?.supportedLocales?.android ?? [];

for (const [label, values] of [
  ['native copy locales', Object.keys(config.locales ?? {})],
  ['iOS supported locales', declaredIos],
  ['Android supported locales', declaredAndroid],
]) {
  if (JSON.stringify([...values].sort()) !== JSON.stringify([...supported].sort())) {
    failures.push(`${label} must contain exactly: ${supported.join(', ')}`);
  }
}

for (const language of supported) {
  const localePath = config.locales?.[language];
  if (!localePath) continue;
  const absolute = path.join(root, localePath);
  if (!fs.existsSync(absolute)) {
    failures.push(`${language}: missing native locale file ${localePath}`);
    continue;
  }
  const nativeCopy = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (nativeCopy.android !== undefined) {
    failures.push(`${language}: iOS permission copy must not be emitted as Android resources`);
  }
  for (const key of permissionKeys) {
    if (typeof nativeCopy.ios?.[key] !== 'string' || !nativeCopy.ios[key].trim()) {
      failures.push(`${language}: missing native permission text ${key}`);
    }
  }
}

const userFacingProps = new Set([
  'title',
  'label',
  'hint',
  'placeholder',
  'accessibilityLabel',
  'accessibilityHint',
  'detail',
  'action',
]);
const allowedLiterals = new Set(['PROTESTCHAT', 'B', 'protestchat:…', 'gate4', 'anon']);
const sourceFiles = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(absolute);
    else if (/\.(ts|tsx)$/.test(entry.name)) sourceFiles.push(absolute);
  }
}

collect(path.join(root, 'src/app'));
collect(path.join(root, 'src/components'));
sourceFiles.push(path.join(root, 'src/lib/conversation.ts'));

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

for (const file of sourceFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const relative = path.relative(root, file);

  function report(node, value) {
    const normalized = value.trim();
    if (!allowedLiterals.has(normalized) && !/^(?:https?:\/\/)?[\w.-]+\/[^\s]+$/.test(normalized)) {
      failures.push(`${relative}:${lineOf(sourceFile, node)} hard-coded user-facing copy: ${JSON.stringify(normalized)}`);
    }
  }

  function visit(node) {
    if (ts.isJsxText(node) && /[A-Za-z]{2}/.test(node.text)) report(node, node.text);

    if (ts.isJsxAttribute(node) && userFacingProps.has(node.name.text)) {
      const initialiser = node.initializer;
      if (initialiser && ts.isStringLiteral(initialiser)) report(initialiser, initialiser.text);
      if (initialiser && ts.isJsxExpression(initialiser)) {
        const expression = initialiser.expression;
        if (expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))) {
          report(expression, expression.text);
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(sourceFile);
      const method = node.expression.name.text;
      if (owner === 'Alert' && method === 'alert') {
        for (const argument of node.arguments.slice(0, 2)) {
          if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) report(argument, argument.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

const summary = [
  '### Localization audit',
  '',
  `- Languages: ${supported.join(', ')}`,
  `- Native permission entries: ${supported.length * permissionKeys.length}`,
  `- Source files checked: ${sourceFiles.length}`,
  `- Result: ${failures.length ? `failed (${failures.length})` : 'passed'}`,
  '',
].join('\n');

if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.stdout.write(summary);

if (failures.length) {
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
}
