/**
 * Browser-side Computer Vision: MediaPipe Pose Landmarker integration & skeleton drawing.
 *
 * Privacy: All inference runs locally in-browser via WebAssembly / WebGL. No video frames
 * or image data are ever uploaded.
 *
 * Graceful degradation: If WebGL is unavailable, WASM assets are missing, or model files fail to load,
 * the detector reports the error cleanly and sensor recording/monitoring continues unhindered.
 */
import { CONFIG } from './config.js';
import {
  extractPoseIndicators,
  evaluateLighting,
  POSE_CONNECTIONS,
  isVisible,
  LANDMARK_INDEX,
  DISCLAIMER_TEXT,
} from './pose-math.js';

export const POSE_STATE = {
  UNINITIALIZED: 'uninitialized',
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
};

export class PoseTracker {
  constructor({ config = CONFIG.pose } = {}) {
    this.config = config;
    this.state = POSE_STATE.UNINITIALIZED;
    this.errorMsg = '';
    this.landmarker = null;
    this.isLowLight = false;
    this.lastLuma = 128;
    this._offscreenCanvas = null;
    this._offscreenCtx = null;
    this._lastVideoTimestamp = -1;
  }

  async init() {
    if (this.state === POSE_STATE.READY && this.landmarker) return true;
    if (this.state === POSE_STATE.LOADING) return false;

    this.state = POSE_STATE.LOADING;
    this.errorMsg = '';

    try {
      // Dynamic import of the local MediaPipe vision bundle
      const visionModule = await import(this.config.bundleUrl);
      const { FilesetResolver, PoseLandmarker } = visionModule;

      if (!FilesetResolver || !PoseLandmarker) {
        throw new Error('MediaPipe vision bundle exports missing.');
      }

      const wasmPath = new URL(this.config.wasmBase, window.location.href).href;
      const modelPath = new URL(this.config.modelUrl, window.location.href).href;

      const vision = await FilesetResolver.forVisionTasks(wasmPath);

      // Try GPU delegate first, fallback to CPU if GPU initialization fails
      let landmarker = null;
      try {
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelPath,
            delegate: 'GPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch (gpuErr) {
        console.warn('MediaPipe GPU initialization failed, falling back to CPU:', gpuErr.message);
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelPath,
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      }

      this.landmarker = landmarker;
      this.state = POSE_STATE.READY;
      return true;
    } catch (err) {
      console.warn('Pose Landmarker initialization failed:', err);
      this.state = POSE_STATE.ERROR;
      this.errorMsg = `Pose estimation unavailable: ${err.message || 'Failed to load model'}.`;
      return false;
    }
  }

  /**
   * Process a single video frame. Returns extracted pose result.
   * Enforces strictly monotonic timestamps to support replay, scrubbing, and backwards seeking.
   * @param {HTMLVideoElement|HTMLCanvasElement} videoSource
   * @param {number} timestampMs Frame timestamp in ms
   */
  processFrame(videoSource, timestampMs = 0) {
    if (this.state !== POSE_STATE.READY || !this.landmarker) {
      return null;
    }
    if (!videoSource || (videoSource.videoWidth === 0 && videoSource.width === 0)) {
      return null;
    }

    let tMs = Math.round(Number(timestampMs) || 0);
    if (tMs <= this._lastVideoTimestamp) {
      tMs = this._lastVideoTimestamp + 1;
    }
    this._lastVideoTimestamp = tMs;

    try {
      const result = this.landmarker.detectForVideo(videoSource, tMs);
      const landmarks = result?.landmarks?.[0] || null;

      // Check lighting periodically using small offscreen sample
      this._checkLighting(videoSource);

      if (!landmarks) {
        return {
          detected: false,
          landmarks: null,
          indicators: null,
          isLowLight: this.isLowLight,
          disclaimer: DISCLAIMER_TEXT,
        };
      }

      const indicators = extractPoseIndicators(landmarks, {
        minVisibility: this.config.minVisibility,
      });

      return {
        detected: true,
        landmarks,
        indicators,
        isLowLight: this.isLowLight,
        disclaimer: DISCLAIMER_TEXT,
      };
    } catch (err) {
      console.warn('Pose detection error:', err);
      return null;
    }
  }

  _checkLighting(source) {
    const w = source.videoWidth || source.width || 0;
    const h = source.videoHeight || source.height || 0;
    if (w === 0 || h === 0) return;

    if (!this._offscreenCanvas) {
      this._offscreenCanvas = document.createElement('canvas');
      this._offscreenCanvas.width = 64;
      this._offscreenCanvas.height = 36;
      this._offscreenCtx = this._offscreenCanvas.getContext('2d', { willReadFrequently: true });
    }

    try {
      this._offscreenCtx.drawImage(source, 0, 0, 64, 36);
      const imgData = this._offscreenCtx.getImageData(0, 0, 64, 36);
      const { meanLuma, isLowLight } = evaluateLighting(imgData.data, this.config.lowLightLuma);
      this.lastLuma = meanLuma;
      this.isLowLight = isLowLight;
    } catch {
      // Ignored if cross-origin or canvas read fails
    }
  }

  /**
   * Render skeletal overlay onto a 2D canvas context.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array<{x:number, y:number, visibility?:number}>} landmarks
   * @param {number} width Canvas width
   * @param {number} height Canvas height
   */
  drawOverlay(ctx, landmarks, width, height, { showAngles = true } = {}) {
    if (!ctx || !Array.isArray(landmarks)) return;

    ctx.save();
    ctx.clearRect(0, 0, width, height);

    const minVis = this.config.minVisibility || 0.5;

    // Draw skeletal connections
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.85)'; // Neon emerald
    ctx.shadowColor = 'rgba(52, 211, 153, 0.5)';
    ctx.shadowBlur = 6;

    for (const [startIdx, endIdx] of POSE_CONNECTIONS) {
      const p1 = landmarks[startIdx];
      const p2 = landmarks[endIdx];
      if (isVisible(p1, minVis) && isVisible(p2, minVis)) {
        ctx.beginPath();
        ctx.moveTo(p1.x * width, p1.y * height);
        ctx.lineTo(p2.x * width, p2.y * height);
        ctx.stroke();
      }
    }

    // Draw landmarks / joints
    ctx.shadowBlur = 4;
    for (let i = 0; i < landmarks.length; i++) {
      const lm = landmarks[i];
      if (!isVisible(lm, minVis)) continue;

      const px = lm.x * width;
      const py = lm.y * height;

      // Color coding: primary joints (elbows/knees/wrists) in bright blue, torso in amber
      let color = '#60a5fa'; // Blue
      let radius = 4.5;

      if (i === LANDMARK_INDEX.LEFT_ELBOW || i === LANDMARK_INDEX.RIGHT_ELBOW) {
        color = '#38bdf8';
        radius = 5.5;
      } else if (i === LANDMARK_INDEX.LEFT_KNEE || i === LANDMARK_INDEX.RIGHT_KNEE) {
        color = '#fbbf24';
        radius = 5.5;
      } else if (i === LANDMARK_INDEX.LEFT_WRIST || i === LANDMARK_INDEX.RIGHT_WRIST) {
        color = '#f472b6';
        radius = 5;
      }

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#0b1020';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.restore();
  }

  dispose() {
    if (this.landmarker) {
      try {
        this.landmarker.close();
      } catch { /* ignore */ }
      this.landmarker = null;
    }
    this.state = POSE_STATE.UNINITIALIZED;
  }
}

/**
 * Accurately aligns a transparent canvas over an HTMLVideoElement taking into account
 * object-fit: contain (letterboxing and pillarboxing).
 * Sets matching CSS bounds and coordinate space dimensions so drawn landmarks lie
 * precisely over video pixels.
 * @param {HTMLVideoElement} video
 * @param {HTMLCanvasElement} canvas
 */
export function alignCanvasToVideo(video, canvas) {
  if (!video || !canvas) return null;
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 360;
  const cw = video.clientWidth;
  const ch = video.clientHeight;

  if (!cw || !ch) {
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw;
      canvas.height = vh;
    }
    return { x: 0, y: 0, width: cw, height: ch, videoWidth: vw, videoHeight: vh };
  }

  const videoRatio = vw / vh;
  const elementRatio = cw / ch;

  let renderWidth = cw;
  let renderHeight = ch;
  let offsetX = 0;
  let offsetY = 0;

  if (elementRatio > videoRatio) {
    // Pillarboxed (bars on left and right)
    renderWidth = ch * videoRatio;
    offsetX = (cw - renderWidth) / 2;
  } else {
    // Letterboxed (bars on top and bottom)
    renderHeight = cw / videoRatio;
    offsetY = (ch - renderHeight) / 2;
  }

  // Adjust style positioning to match the video content box exactly
  canvas.style.position = 'absolute';
  canvas.style.left = `${Math.round(offsetX)}px`;
  canvas.style.top = `${Math.round(offsetY)}px`;
  canvas.style.width = `${Math.round(renderWidth)}px`;
  canvas.style.height = `${Math.round(renderHeight)}px`;

  if (canvas.width !== vw || canvas.height !== vh) {
    canvas.width = vw;
    canvas.height = vh;
  }

  return {
    x: offsetX,
    y: offsetY,
    width: renderWidth,
    height: renderHeight,
    videoWidth: vw,
    videoHeight: vh,
  };
}
