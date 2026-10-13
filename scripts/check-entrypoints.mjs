import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const slash = (value) => value.replaceAll('\\', '/');

export function sources(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory())
      return ['dist', 'node_modules', 'test'].includes(entry.name) ? [] : sources(path);
    return /\.[cm]?[jt]sx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

export function checkEntrypoints(root = process.cwd()) {
  const packages = ['apps', 'platform', 'packages', 'modules'].flatMap((area) => {
    if (!existsSync(resolve(root, area))) return [];
    return readdirSync(resolve(root, area)).flatMap((name) => {
      const directory = resolve(root, area, name);
      const manifest = resolve(directory, 'package.json');
      return existsSync(manifest)
        ? [{ directory, ...JSON.parse(readFileSync(manifest, 'utf8')) }]
        : [];
    });
  });
  const errors = [];
  for (const app of packages.filter((pkg) =>
    slash(relative(root, pkg.directory)).startsWith('apps/'),
  )) {
    const configPath = resolve(app.directory, 'tsconfig.json');
    const parsed = existsSync(configPath)
      ? ts.parseJsonConfigFileContent(
          ts.readConfigFile(configPath, ts.sys.readFile).config,
          ts.sys,
          app.directory,
        )
      : { options: { moduleResolution: ts.ModuleResolutionKind.NodeNext } };
    for (const file of sources(resolve(app.directory, 'src'))) {
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const location = slash(relative(root, file));
      const report = (rule) => errors.push(`${location}: ${rule}`);
      const processMain = /apps\/(api|worker)\/src\/main\.ts$/u.test(location);
      const main = basename(file).startsWith('main.');
      const inspectImport = (specifier) => {
        const declared = packages.find(
          (pkg) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`),
        );
        const resolved = ts.resolveModuleName(specifier, file, parsed.options, ts.sys)
          .resolvedModule?.resolvedFileName;
        const target = resolved
          ? resolve(resolved)
          : specifier.startsWith('.')
            ? resolve(dirname(file), specifier)
            : declared?.directory;
        const owner =
          target &&
          packages.find(
            (pkg) =>
              target === pkg.directory ||
              target.startsWith(`${pkg.directory}/`) ||
              target.startsWith(`${pkg.directory}\\`),
          );
        if (
          (owner && owner !== app && slash(relative(root, owner.directory)).startsWith('apps/')) ||
          (declared &&
            declared !== app &&
            slash(relative(root, declared.directory)).startsWith('apps/'))
        )
          report('no-cross-app-imports');
        if (owner && owner !== app && owner.exports) {
          const exports =
            typeof owner.exports === 'object' &&
            Object.keys(owner.exports).some((key) => key.startsWith('.'))
              ? Object.keys(owner.exports)
              : ['.'];
          const publicImports = exports.map((key) =>
            key === '.' ? owner.name : `${owner.name}/${key.slice(2)}`,
          );
          if (!publicImports.includes(specifier)) report('public-package-exports-only');
        }
        if (
          declared &&
          declared !== app &&
          declared.exports &&
          specifier !== declared.name &&
          !(
            typeof declared.exports === 'object' &&
            `.${specifier.slice(declared.name.length)}` in declared.exports
          )
        )
          report('public-package-exports-only');
        if (
          location.startsWith('apps/web/') &&
          (/^(node:|@qapaq\/configuration|@nestjs\/)/u.test(specifier) ||
            (owner && slash(relative(root, owner.directory)).startsWith('platform/')))
        )
          report('browser-public-config-only');
        if (!processMain && /^(?:node:)?process$/u.test(specifier))
          report('environment-at-process-boundary');
        if (
          main &&
          !/^(?:node:url|@qapaq\/configuration|\.\/bootstrap(?:\/bootstrap)?\.js|\.\/app\/styles\.css)$/u.test(
            specifier,
          )
        )
          report('thin-main-imports');
        if (
          !location.endsWith('/composition-root.ts') &&
          !location.endsWith('/bootstrap/bootstrap.tsx') &&
          /^(?:@nestjs\/core|@nestjs\/platform-|fastify$|ioredis$|bullmq$|@prisma\/|@opensearch-project\/)/u.test(
            specifier,
          )
        )
          report('clients-in-composition-root');
      };
      function visit(node) {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        )
          inspectImport(node.moduleSpecifier.text);
        if (
          ts.isImportTypeNode(node) &&
          ts.isLiteralTypeNode(node.argument) &&
          ts.isStringLiteral(node.argument.literal)
        )
          inspectImport(node.argument.literal.text);
        if (
          ts.isImportEqualsDeclaration(node) &&
          ts.isExternalModuleReference(node.moduleReference) &&
          node.moduleReference.expression &&
          ts.isStringLiteral(node.moduleReference.expression)
        )
          inspectImport(node.moduleReference.expression.text);
        if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
        ) {
          const argument = node.arguments[0];
          if (argument && ts.isStringLiteralLike(argument)) inspectImport(argument.text);
          else report('statically-resolvable-imports-only');
        }
        // Cubre accesos por propiedad o índice, desestructuración y alias de process. Un nombre de
        // propiedad (`{ process: 'Procesos' }`, `x.process`) no es el global y no se reporta.
        if (
          !processMain &&
          ts.isIdentifier(node) &&
          node.text === 'process' &&
          !(
            (ts.isPropertyAssignment(node.parent) || ts.isPropertyAccessExpression(node.parent)) &&
            node.parent.name === node
          )
        )
          report('environment-at-process-boundary');
        if (
          main &&
          ts.isNewExpression(node) &&
          !['Date', 'Error'].includes(node.expression.getText(source))
        )
          report('no-business-construction-in-main');
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  return [...new Set(errors)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkEntrypoints();
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  } else process.stdout.write('Entrypoint architecture: PASS\n');
}
