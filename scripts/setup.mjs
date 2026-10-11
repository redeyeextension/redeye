// Copies the MediaPipe runtime (JS + wasm) from node_modules into ./vendor and downloads the
// face_landmarker model. Run once:  npm install && npm run setup
import { mkdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision');
const vendor = path.join(root, 'vendor');
const MODEL_FILE = path.join(vendor, 'face_landmarker.task');
const BASE = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16';
const MODEL_URLS = [process.env.RED_EYE_MODEL_URL, `${BASE}/1/face_landmarker.task`, `${BASE}/latest/face_landmarker.task`].filter(Boolean);

function fail(msg) { console.error('\n✖ ' + msg + '\n'); process.exit(1); }

if (!existsSync(pkg)) fail('node_modules/@mediapipe/tasks-vision not found. Run "npm install" first.');

await mkdir(path.join(vendor, 'wasm'), { recursive: true });
await copyFile(path.join(pkg, 'vision_bundle.mjs'), path.join(vendor, 'vision_bundle.mjs'));
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']) {
  await copyFile(path.join(pkg, 'wasm', f), path.join(vendor, 'wasm', f));
}
console.log('✔ MediaPipe runtime copied to vendor/');

async function modelOk() {
  try { return (await stat(MODEL_FILE)).size > 1_000_000; } catch { return false; }
}

if (await modelOk()) {
  console.log('✔ Model already present: vendor/face_landmarker.task');
} else {
  let done = false;
  for (const url of MODEL_URLS) {
    try {
      process.stdout.write(`… downloading model from ${url}\n`);
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      // a .task file is a zip archive: it must start with "PK"
      if (buf.length < 1_000_000 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('unexpected file content');
      await writeFile(MODEL_FILE, buf);
      console.log(`✔ Model saved (${(buf.length / 1e6).toFixed(1)} MB)`);
      done = true;
      break;
    } catch (e) {
      console.warn('  failed: ' + e.message);
    }
  }
  if (!done) {
    fail('Could not download the model automatically.\n' +
      '  Download it in your browser from:\n    ' + MODEL_URLS[MODEL_URLS.length - 2] + '\n' +
      '  and save it as:\n    vendor/face_landmarker.task\n' +
      '  (or set RED_EYE_MODEL_URL to another mirror and run "npm run setup" again)');
  }
}

console.log('\nDone. Now open chrome://extensions, enable Developer mode, click "Load unpacked" and pick this folder.');
