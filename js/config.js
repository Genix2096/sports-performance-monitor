/**
 * Central configuration. This is the ONE place to edit:
 *  - the ESP8266 address/port (esp.host / esp.port)
 *  - per-sport swing detection thresholds
 *  - per-sport effective radius used for the swing speed ESTIMATE
 *
 * The ESP8266 address can also be changed at runtime on the Session Setup
 * screen (it is remembered in the browser); this file provides the default.
 */
export const INCHES_TO_METERS = 0.0254;

export const CONFIG = {
  esp: {
    host: '192.168.1.50', // <-- put the IP printed by the ESP8266 on the Serial Monitor
    port: 81, // must match WS_PORT in firmware/esp8266_mpu6050.ino
    connectTimeoutMs: 5000,
    staleMs: 7000, // no message for this long => "connection lost" (tolerates MPU init & WiFi jitter)
    reconnectMs: 3000,
  },

  // Expected sample rates (Hz). Firmware default is 50 Hz (SAMPLE_INTERVAL_MS = 20).
  sampleRateHz: { demo: 50, live: 50 },

  charts: {
    windowSeconds: 10, // rolling window of the live graphs
    renderFps: 12, // max UI refresh rate
    reportMaxPoints: 1500, // downsampling target for report graphs
  },

  limits: {
    maxStoredSamples: 60000, // above this the stored series is decimated (stats stay exact)
    maxGapMs: 2000, // a gap longer than this is not counted as active time
    maxImportSamples: 300000,
    maxImportBytes: 60 * 1024 * 1024,
  },

  // Sanity limits for incoming samples (MPU6050 range set by firmware: +-16 g, +-2000 dps)
  sensorLimits: { maxG: 32, maxDps: 4000 },

  /**
   * Webcam recording (browser MediaRecorder). The video stays in browser memory only — it is never
   * sent to the ESP8266, the Node server or any cloud service. See README "Video, sync & pose".
   *  maxDurationS / maxBytes  recording is stopped automatically above either limit (memory safety)
   *  maxInMemory              most recent recordings kept in this tab; older ones are released
   *  defaultPreS / defaultPostS  replay padding around a swing peak (seconds)
   */
  video: {
    idealWidth: 1280,
    idealHeight: 720,
    frameRate: 30,
    videoBitsPerSecond: 2500000, // ~19 MB per minute
    timesliceMs: 1000,
    maxDurationS: 20 * 60,
    maxBytes: 800 * 1024 * 1024,
    maxInMemory: 3,
    defaultPreS: 1.5,
    defaultPostS: 1.5,
    maxPadS: 10,
  },

  /**
   * Pose estimation (MediaPipe Pose Landmarker "lite", runs locally via WebAssembly).
   * Model and runtime are served by the local Node server (npm run fetch-model downloads the model once).
   */
  pose: {
    bundleUrl: '../vendor/mediapipe/vision_bundle.mjs', // relative to js/pose.js
    wasmBase: '../vendor/mediapipe/wasm',
    modelUrl: '../models/pose_landmarker_lite.task',
    liveFps: 10, // max live inference rate; lowered automatically if inference is slow
    minVisibility: 0.5, // landmarks below this visibility are not used for indicators
    lowLightLuma: 45, // mean frame luma (0-255) below which a low-light warning is shown
    associateToleranceMs: 150, // max distance between a swing peak and a live pose frame
  },

  /** Sensor-to-browser clock mapping (see js/sync.js). */
  sync: {
    clockWindowMs: 3000, // lower-envelope window for the sensor->browser clock offset
    edgeToleranceMs: 100,
  },

  /**
   * Swing detector parameters (see js/analytics.js SwingDetector).
   *  startDps       gyro magnitude that begins a candidate swing
   *  endDps         gyro magnitude below which the swing ends (hysteresis / re-arming level)
   *  minPeakDps     candidate must reach this peak angular velocity to count
   *  minPeakG       candidate must reach this peak acceleration magnitude to count
   *  minDurationMs  / maxDurationMs  plausible swing duration window
   *  cooldownMs     dead time after a swing before another can start
   *  maxGapMs       missing-sample gap that aborts a candidate swing
   *
   *  radiusM = fallback effective radius (axis of rotation -> hitting zone) if equipment length is not given.
   *  equipmentDefaults = sensible editable default length (inches) and weight (grams) per sport.
   *  equipmentLimits = physical validation bounds for equipment inputs.
   *  biomechanics = rotation geometry for sensor mounted below grip:
   *    pivotOffsetM: distance from effective rotation axis (wrist/arm) to handle butt end.
   *    sweetSpotRatio: location of hitting zone / sweet spot as fraction of equipment length from butt end.
   *    Effective radius r_eff = pivotOffsetM + sweetSpotRatio * (lengthInches * 0.0254).
   */
  sports: {
    cricket: {
      label: 'Cricket',
      equipment: 'bat',
      radiusM: 0.85,
      equipmentDefaults: { lengthInches: 33.5, weightGrams: 1200 },
      equipmentLimits: { minLengthInches: 20.0, maxLengthInches: 42.0, minWeightGrams: 500, maxWeightGrams: 2000 },
      biomechanics: { pivotOffsetM: 0.254, sweetSpotRatio: 0.70 },
      swing: { startDps: 250, endDps: 120, minPeakDps: 350, minPeakG: 1.8, minDurationMs: 80, maxDurationMs: 1500, cooldownMs: 600, maxGapMs: 250 },
      sim: { peakDps: [450, 900], peakG: [3, 6], intervalS: [2.5, 5] },
    },
    badminton: {
      label: 'Badminton',
      equipment: 'racket',
      radiusM: 0.6,
      equipmentDefaults: { lengthInches: 26.8, weightGrams: 85 },
      equipmentLimits: { minLengthInches: 18.0, maxLengthInches: 32.0, minWeightGrams: 60, maxWeightGrams: 160 },
      biomechanics: { pivotOffsetM: 0.090, sweetSpotRatio: 0.75 },
      swing: { startDps: 350, endDps: 150, minPeakDps: 500, minPeakG: 2.0, minDurationMs: 80, maxDurationMs: 1200, cooldownMs: 400, maxGapMs: 250 },
      sim: { peakDps: [700, 1400], peakG: [4, 8], intervalS: [1.5, 3.5] },
    },
    tennis: {
      label: 'Tennis',
      equipment: 'racket',
      radiusM: 0.75,
      equipmentDefaults: { lengthInches: 27.0, weightGrams: 300 },
      equipmentLimits: { minLengthInches: 19.0, maxLengthInches: 34.0, minWeightGrams: 180, maxWeightGrams: 450 },
      biomechanics: { pivotOffsetM: 0.236, sweetSpotRatio: 0.75 },
      swing: { startDps: 300, endDps: 140, minPeakDps: 450, minPeakG: 2.0, minDurationMs: 80, maxDurationMs: 1400, cooldownMs: 700, maxGapMs: 250 },
      sim: { peakDps: [600, 1200], peakG: [3, 7], intervalS: [2, 4.5] },
    },
  },
};

export const SPORT_IDS = Object.keys(CONFIG.sports);
