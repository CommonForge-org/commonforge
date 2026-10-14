import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { API } from 'typescript/unstable/sync';
import { SyntaxKind, type Node } from 'typescript/unstable/ast';
import { isAssignmentOperator, isBinaryExpression, isCallExpression, isElementAccessExpression, isPropertyAccessExpression, isPrefixUnaryExpression } from 'typescript/unstable/ast/is';

export interface ByteWorkMatcher {
  matcher: (attributes: string) => (path: string) => boolean;
  resetBudget: (limit: number) => void;
  reads: () => number;
}

/**
 * Instrument the current source's byte reads without proxying/deoptimizing its native arrays.
 * Wrap every element read and .length read, including direct reads outside the P/T helpers.
 * The wrapper delegates to the original value; only Uint8Array probes spend the budget.
 * Nothing is injected into production source or its published artifacts.
 */
export async function byteWorkMatcher(source: URL): Promise<ByteWorkMatcher> {
  const text = await readFile(source, 'utf8');
  if (text.includes('__cforgeByteWork_')) throw new Error('byte-work instrumentation name collides with source');
  const scratch = await mkdtemp(join(tmpdir(), 'cforge-byte-work-'));
  const api = new API();
  try {
    // A minimal project parses only the production file, not the workspace's test graph.
    const config = join(scratch, 'tsconfig.json');
    await writeFile(config, JSON.stringify({ files: [fileURLToPath(source)], compilerOptions: { noLib: true } }));
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    const ast = snapshot.getProject(config)?.program.getSourceFile(fileURLToPath(source));
    if (!ast) throw new Error('byte-work instrumentation could not parse source');
    function instrument(node: Node): string {
      if (isElementAccessExpression(node) || (isPropertyAccessExpression(node) && node.name.text === 'length')) {
        const parent = node.parent;
        // Reject future access forms whose semantics a function wrapper would change.
        if (node.questionDotToken ||
            (isBinaryExpression(parent) && parent.left === node && isAssignmentOperator(parent.operatorToken.kind)) ||
            (isCallExpression(parent) && parent.expression === node) ||
            parent.kind === SyntaxKind.DeleteExpression ||
            parent.kind === SyntaxKind.PostfixUnaryExpression ||
            (isPrefixUnaryExpression(parent) && (parent.operator === SyntaxKind.PlusPlusToken || parent.operator === SyntaxKind.MinusMinusToken))) {
          throw new Error('byte-work instrumentation requires an ordinary read');
        }
        const key = isElementAccessExpression(node) ? instrument(node.argumentExpression) : '"length"';
        return `__cforgeByteWork_read(${instrument(node.expression)}, ${key})`;
      }
      let offset = node.getStart(ast);
      let result = '';
      node.forEachChild((child) => {
        result += text.slice(offset, child.getStart(ast)) + instrument(child);
        offset = child.end;
      });
      return result + text.slice(offset, node.end);
    }
    const instrumented = instrument(ast);
    snapshot.dispose();
    const input = join(scratch, 'apply-files.ts');
    await writeFile(input, instrumented + `
      let __cforgeByteWork_count = 0;
      let __cforgeByteWork_limit = Infinity;
      function __cforgeByteWork_read(target: any, key: any) {
        if (target instanceof Uint8Array && ++__cforgeByteWork_count > __cforgeByteWork_limit) {
          throw new Error('wildmatch byte work exceeded ' + __cforgeByteWork_limit);
        }
        return target[key];
      }
      export function __cforgeByteWork_reset(limit: number) { __cforgeByteWork_count = 0; __cforgeByteWork_limit = limit; }
      export function __cforgeByteWork_reads() { return __cforgeByteWork_count; }
    `);
    const tsc = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url));
    await promisify(execFile)(tsc, ['--ignoreConfig', '--target', 'ES2023', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--skipLibCheck', '--outDir', join(scratch, 'out'), input], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: 10_000,
    });
    const compiled = await readFile(join(scratch, 'out', 'apply-files.js'), 'utf8');
    const url = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
    const module = await import(/* @vite-ignore */ url);
    return { matcher: module.lfsAttributesMatcher, resetBudget: module.__cforgeByteWork_reset, reads: module.__cforgeByteWork_reads };
  } finally {
    api.close();
    await rm(scratch, { recursive: true, force: true });
  }
}
