/**
 * Pure pose geometry and indicator calculations (no DOM, no WebGL, unit-tested in Node).
 *
 * MediaPipe landmark index mapping:
 *  11: left_shoulder, 12: right_shoulder
 *  13: left_elbow,    14: right_elbow
 *  15: left_wrist,    16: right_wrist
 *  23: left_hip,      24: right_hip
 *  25: left_knee,     26: right_knee
 *  27: left_ankle,    28: right_ankle
 *
 * IMPORTANT BIOMECHANICS & ACCURACY NOTE:
 * All measurements computed here are 2D geometric indicators projected onto the camera image plane.
 * They are NOT true 3D biomechanical measurements and are NOT medical advice or definitive coaching
 * judgments. Angle measurements depend heavily on camera viewpoint, foreshortening and clothing.
 */

export const LANDMARK_INDEX = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
};

export const POSE_CONNECTIONS = [
  // Torso
  [11, 12], [11, 23], [12, 24], [23, 24],
  // Left arm
  [11, 13], [13, 15],
  // Right arm
  [12, 14], [14, 16],
  // Left leg
  [23, 25], [25, 27],
  // Right leg
  [24, 26], [26, 28],
];

export const DISCLAIMER_TEXT = 'Single-webcam 2D optical indicators (not true 3D biomechanics or medical coaching). Values reflect camera-plane projections.';

/** Check if a landmark is valid and has acceptable visibility/confidence. */
export function isVisible(lm, minVisibility = 0.5) {
  if (!lm || typeof lm !== 'object') return false;
  if (typeof lm.x !== 'number' || !Number.isFinite(lm.x)) return false;
  if (typeof lm.y !== 'number' || !Number.isFinite(lm.y)) return false;
  const vis = typeof lm.visibility === 'number' ? lm.visibility : (typeof lm.presence === 'number' ? lm.presence : 1);
  return vis >= minVisibility;
}

/**
 * Calculate 2D interior angle (degrees, 0-180) at vertex B between segments BA and BC.
 * Returns null if any point is missing, invisible, or degenerate (length 0).
 */
export function calculateJointAngle(pointA, pointB, pointC, minVisibility = 0.5) {
  if (!isVisible(pointA, minVisibility) || !isVisible(pointB, minVisibility) || !isVisible(pointC, minVisibility)) {
    return null;
  }
  const v1x = pointA.x - pointB.x;
  const v1y = pointA.y - pointB.y;
  const v2x = pointC.x - pointB.x;
  const v2y = pointC.y - pointB.y;

  const mag1 = Math.hypot(v1x, v1y);
  const mag2 = Math.hypot(v2x, v2y);
  if (mag1 < 1e-6 || mag2 < 1e-6) return null;

  const dot = v1x * v2x + v1y * v2y;
  const cosTheta = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
  const deg = Math.acos(cosTheta) * (180 / Math.PI);
  return Math.round(deg * 10) / 10;
}

/**
 * Calculate tilt angle of a segment (A -> B) relative to horizontal in degrees.
 * E.g. shoulder line (left to right) or hip line.
 * Positive = tilted downwards to the right (in screen coordinates where y increases downwards).
 */
export function calculateLineTilt(pointA, pointB, minVisibility = 0.5) {
  if (!isVisible(pointA, minVisibility) || !isVisible(pointB, minVisibility)) return null;
  const dx = pointB.x - pointA.x;
  const dy = pointB.y - pointA.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  const rad = Math.atan2(dy, dx);
  let deg = rad * (180 / Math.PI);
  // Normalize to -90 to 90 range (absolute deviation from horizontal)
  if (deg > 90) deg -= 180;
  if (deg < -90) deg += 180;
  return Math.round(deg * 10) / 10;
}

/**
 * Calculate torso inclination (spine tilt) relative to vertical in degrees.
 * Mid-shoulder to mid-hip line compared against pure vertical (0° = upright).
 */
export function calculateTorsoInclination(leftShoulder, rightShoulder, leftHip, rightHip, minVisibility = 0.5) {
  const shVis = isVisible(leftShoulder, minVisibility) && isVisible(rightShoulder, minVisibility);
  const hipVis = isVisible(leftHip, minVisibility) && isVisible(rightHip, minVisibility);
  if (!shVis || !hipVis) return null;

  const midShX = (leftShoulder.x + rightShoulder.x) / 2;
  const midShY = (leftShoulder.y + rightShoulder.y) / 2;
  const midHipX = (leftHip.x + rightHip.x) / 2;
  const midHipY = (leftHip.y + rightHip.y) / 2;

  // Vector from hip up to shoulder (in screen space, shoulder has smaller y than hip)
  const dx = midShX - midHipX;
  const dy = midHipY - midShY; // dy > 0 when shoulder is above hip
  if (Math.hypot(dx, dy) < 1e-6) return null;

  // Angle with vertical (dx = 0, dy > 0 is 0° inclination)
  const deg = Math.abs(Math.atan2(dx, dy)) * (180 / Math.PI);
  return Math.round(deg * 10) / 10;
}

/**
 * Evaluate mean luminance from pixel buffer or grayscale array to detect low-lighting conditions.
 * @param {Uint8ClampedArray|number[]} rgbaData
 * @returns {{meanLuma: number, isLowLight: boolean}}
 */
export function evaluateLighting(rgbaData, threshold = 45) {
  if (!rgbaData || rgbaData.length < 4) return { meanLuma: 128, isLowLight: false };
  let sum = 0;
  const step = Math.max(4, Math.floor(rgbaData.length / 1000) * 4); // Sample up to 1000 pixels
  let count = 0;
  for (let i = 0; i < rgbaData.length; i += step) {
    const r = rgbaData[i];
    const g = rgbaData[i + 1];
    const b = rgbaData[i + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
    count++;
  }
  const meanLuma = count > 0 ? Math.round(sum / count) : 128;
  return { meanLuma, isLowLight: meanLuma < threshold };
}

/**
 * Extract comprehensive interpretable pose indicators from a landmark list.
 * @param {Array<{x:number, y:number, z?:number, visibility?:number}>} landmarks
 * @param {object} [opts]
 */
export function extractPoseIndicators(landmarks, { minVisibility = 0.5 } = {}) {
  if (!Array.isArray(landmarks) || landmarks.length < 29) {
    return {
      available: false,
      overallConfidence: 0,
      visibleJointsCount: 0,
      indicators: null,
      disclaimer: DISCLAIMER_TEXT,
    };
  }

  const lm = landmarks;
  const I = LANDMARK_INDEX;

  const leftShoulder = lm[I.LEFT_SHOULDER];
  const rightShoulder = lm[I.RIGHT_SHOULDER];
  const leftElbow = lm[I.LEFT_ELBOW];
  const rightElbow = lm[I.RIGHT_ELBOW];
  const leftWrist = lm[I.LEFT_WRIST];
  const rightWrist = lm[I.RIGHT_WRIST];
  const leftHip = lm[I.LEFT_HIP];
  const rightHip = lm[I.RIGHT_HIP];
  const leftKnee = lm[I.LEFT_KNEE];
  const rightKnee = lm[I.RIGHT_KNEE];
  const leftAnkle = lm[I.LEFT_ANKLE];
  const rightAnkle = lm[I.RIGHT_ANKLE];

  const coreJoints = [
    leftShoulder, rightShoulder, leftElbow, rightElbow,
    leftWrist, rightWrist, leftHip, rightHip,
    leftKnee, rightKnee, leftAnkle, rightAnkle,
  ];

  let visibleCount = 0;
  let visSum = 0;
  for (const j of coreJoints) {
    const v = typeof j?.visibility === 'number' ? j.visibility : (typeof j?.presence === 'number' ? j.presence : 1);
    visSum += v;
    if (v >= minVisibility) visibleCount++;
  }
  const overallConfidence = Math.round((visSum / coreJoints.length) * 100) / 100;

  // Calculate interpretable indicators
  const leftElbowAngle = calculateJointAngle(leftShoulder, leftElbow, leftWrist, minVisibility);
  const rightElbowAngle = calculateJointAngle(rightShoulder, rightElbow, rightWrist, minVisibility);
  const leftKneeAngle = calculateJointAngle(leftHip, leftKnee, leftAnkle, minVisibility);
  const rightKneeAngle = calculateJointAngle(rightHip, rightKnee, rightAnkle, minVisibility);
  const shoulderTiltDeg = calculateLineTilt(leftShoulder, rightShoulder, minVisibility);
  const hipTiltDeg = calculateLineTilt(leftHip, rightHip, minVisibility);
  const torsoInclinationDeg = calculateTorsoInclination(leftShoulder, rightShoulder, leftHip, rightHip, minVisibility);

  return {
    available: visibleCount >= 4,
    overallConfidence,
    visibleJointsCount: visibleCount,
    disclaimer: DISCLAIMER_TEXT,
    indicators: {
      leftElbowDeg: leftElbowAngle,
      rightElbowDeg: rightElbowAngle,
      leftKneeDeg: leftKneeAngle,
      rightKneeDeg: rightKneeAngle,
      shoulderTiltDeg,
      hipTiltDeg,
      torsoInclinationDeg,
    },
  };
}
