// Regenerates src/audio/wasm/signalsmithCore.js from the installed
// signalsmith-stretch npm package.
//
// The package's public export is an AudioWorkletNode factory that creates its
// own worklet — unusable inside AUTOTOAD's single ToadProcessor. But the file
// begins with a self-contained Emscripten factory (WASM inlined as base64)
// whose raw exports (_configure/_process/_setTransposeSemitones/...) are
// exactly what the ShifterPool needs. This script copies that factory and
// strips the wrapper tail.
//
// Run after upgrading the package: node scripts/vendor-signalsmith.mjs
// If the factory boundary moves in a future version, the END_MARKER search
// below fails loudly rather than emitting a broken file.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'node_modules/signalsmith-stretch/SignalsmithStretch.mjs');
const targetPath = resolve(root, 'src/audio/wasm/signalsmithCore.js');

const source = readFileSync(sourcePath, 'utf8');
const lines = source.split('\n');

// The Emscripten factory is the IIFE assigned to `var SignalsmithStretch`,
// closed by the first line that is exactly `})();`.
const endIndex = lines.findIndex((line) => line.trim() === '})();');
if (endIndex === -1) {
  throw new Error('vendor-signalsmith: factory end marker `})();` not found — package layout changed.');
}
const factory = lines.slice(0, endIndex + 1).join('\n');
if (!factory.includes('var SignalsmithStretch')) {
  throw new Error('vendor-signalsmith: factory assignment not found — package layout changed.');
}

const header = [
  '// Vendored from signalsmith-stretch@1.3.2 (MIT — Signalsmith Audio / Geraint Luff).',
  '// Raw Emscripten module factory ONLY; the package tail (its own AudioWorkletNode',
  '// wrapper) is stripped so ToadProcessor can instantiate the stretch engine',
  '// directly inside the worklet. Do not edit by hand — regenerate with:',
  '//   node scripts/vendor-signalsmith.mjs',
  '// Typed by signalsmithCore.d.ts.',
  '',
].join('\n');

mkdirSync(dirname(targetPath), { recursive: true });
writeFileSync(targetPath, `${header}${factory}\nexport default SignalsmithStretch;\n`);
console.log(`vendored ${targetPath} (${factory.length} bytes of factory)`);
