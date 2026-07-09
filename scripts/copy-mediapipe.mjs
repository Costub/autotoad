import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const targetDir = join(root, 'public', 'mediapipe', 'wasm');
const readmePath = join(root, 'public', 'mediapipe', 'README.md');

mkdirSync(targetDir, { recursive: true });

if (existsSync(sourceDir)) {
  for (const file of readdirSync(sourceDir)) {
    copyFileSync(join(sourceDir, file), join(targetDir, file));
  }
}

if (!existsSync(readmePath)) {
  mkdirSync(dirname(readmePath), { recursive: true });
  writeFileSync(readmePath, `# MediaPipe assets

The wasm files in \`wasm/\` are copied from \`node_modules/@mediapipe/tasks-vision/wasm\`
by \`npm run copy:mediapipe\`.

Hand tracking also needs the same-origin model file:

\`\`\`
public/mediapipe/hand_landmarker.task
\`\`\`

Download the float16 Hand Landmarker model from:

https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task

If the file is absent, AUTOTOAD runs normally and shows:

"Hand tracking model missing — see public/mediapipe/README"
`);
}

console.log('MediaPipe wasm assets copied to public/mediapipe/wasm');
