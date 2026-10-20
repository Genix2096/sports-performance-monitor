// Download MediaPipe Pose Landmarker Lite task file for local browser inference.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'models');
const MODEL_FILE = path.join(MODELS_DIR, 'pose_landmarker_lite.task');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

if (!fs.existsSync(MODELS_DIR)) {
  fs.mkdirSync(MODELS_DIR, { recursive: true });
}

if (fs.existsSync(MODEL_FILE) && fs.statSync(MODEL_FILE).size > 1000000) {
  console.log(`Pose landmarker model already present at ${MODEL_FILE} (${fs.statSync(MODEL_FILE).size} bytes).`);
  process.exit(0);
}

console.log(`Downloading MediaPipe pose landmarker model from ${MODEL_URL} ...`);
const file = fs.createWriteStream(MODEL_FILE);
https.get(MODEL_URL, (res) => {
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    https.get(res.headers.location, (redirectRes) => {
      redirectRes.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`Downloaded ${MODEL_FILE} (${fs.statSync(MODEL_FILE).size} bytes).`);
      });
    }).on('error', (err) => {
      fs.unlink(MODEL_FILE, () => {});
      console.error('Error following redirect:', err.message);
      process.exit(1);
    });
    return;
  }
  if (res.statusCode !== 200) {
    console.error(`Download failed with HTTP ${res.statusCode}`);
    file.close();
    fs.unlink(MODEL_FILE, () => {});
    process.exit(1);
  }
  res.pipe(file);
  file.on('finish', () => {
    file.close();
    console.log(`Downloaded ${MODEL_FILE} (${fs.statSync(MODEL_FILE).size} bytes).`);
  });
}).on('error', (err) => {
  fs.unlink(MODEL_FILE, () => {});
  console.error('Download error:', err.message);
  process.exit(1);
});
