/**
 * Central configuration. This is the ONE place to edit:
 *  - the ESP8266 address/port (esp.host / esp.port)
 *  - per-sport swing detection thresholds
 *  - per-sport effective radius used for the swing speed ESTIMATE
 *
 * The ESP8266 address can also be changed at runtime on the Session Setup
 * screen (it is remembered in the browser); this file provides the default.
 */
export const CONFIG = {
  esp: {
    host: '192.168.1.50', // <-- put the IP printed by the ESP8266 on the Serial Monitor
    port: 81, // must match WS_PORT in firmware/esp8266_mpu6050.ino
    connectTimeoutMs: 5000,
    staleMs: 3000, // no message for this long => "connection lost"
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
   * Swing detector parameters (see js/analytics.js SwingDetector).
   *  startDps       gyro magnitude that begins a candidate swing
   *  endDps         gyro magnitude below which the swing ends (hysteresis / re-arming level)
   *  minPeakDps     candidate must reach this peak angular velocity to count
   *  minPeakG       candidate must reach this peak acceleration magnitude to count
   *  minDurationMs  / maxDurationMs  plausible swing duration window
   *  cooldownMs     dead time after a swing before another can start
   *  maxGapMs       missing-sample gap that aborts a candidate swing
   *
   *  radiusM = assumed EFFECTIVE radius (axis of rotation -> point of interest) for the
   *            estimated linear speed v = omega * r.  Tune to your equipment.
   */
  sports: {
    cricket: {
      label: 'Cricket',
      equipment: 'bat',
      radiusM: 0.85,
      swing: { startDps: 250, endDps: 120, minPeakDps: 350, minPeakG: 1.8, minDurationMs: 80, maxDurationMs: 1500, cooldownMs: 600, maxGapMs: 250 },
      sim: { peakDps: [450, 900], peakG: [3, 6], intervalS: [2.5, 5] },
    },
    badminton: {
      label: 'Badminton',
      equipment: 'racket',
      radiusM: 0.6,
      swing: { startDps: 350, endDps: 150, minPeakDps: 500, minPeakG: 2.0, minDurationMs: 80, maxDurationMs: 1200, cooldownMs: 400, maxGapMs: 250 },
      sim: { peakDps: [700, 1400], peakG: [4, 8], intervalS: [1.5, 3.5] },
    },
    tennis: {
      label: 'Tennis',
      equipment: 'racket',
      radiusM: 0.75,
      swing: { startDps: 300, endDps: 140, minPeakDps: 450, minPeakG: 2.0, minDurationMs: 80, maxDurationMs: 1400, cooldownMs: 700, maxGapMs: 250 },
      sim: { peakDps: [600, 1200], peakG: [3, 7], intervalS: [2, 4.5] },
    },
  },
};

export const SPORT_IDS = Object.keys(CONFIG.sports);
