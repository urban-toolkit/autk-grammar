// Unit tests for the grammar's types as a host's code compiles against them: the TypeScript compiler checks host-code.ts,
// code a host writes, with strict checks. A patch keeps every host's code compiling. Run with
//   npm run test:unit
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const hostCode = fileURLToPath(new URL('./host-code.ts', import.meta.url));
const program = ts.createProgram([hostCode], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
});
const hostFile = program.getSourceFile(hostCode);
assert.ok(hostFile, 'the compiler reads host-code.ts');
assert.ok(program.getSourceFiles().some((file) => file.fileName.endsWith('/grammar/src/types.ts')), "the compiler reads the grammar's types");
// The errors of the host's code, and of none of the files it reads, which the grammar's own build checks. Its
// `@ts-expect-error` line fails it too, should the grammar's types read as `any`.
const errors = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file === undefined || diagnostic.file === hostFile)
    .map((diagnostic) => {
        const at = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : undefined;
        return `host-code.ts${at === undefined ? '' : `:${at}`}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
    });
assert.deepEqual(errors, [], 'the host code compiles');

console.log('host-types: all cases passed');
