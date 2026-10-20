# Smart Sports Equipment Performance Monitor

A comprehensive web dashboard for monitoring bat and racket swings with an **MPU6050** (6-axis accelerometer + gyroscope) on an **ESP8266 NodeMCU**, synchronized with **laptop webcam recording** and **client-side MediaPipe pose estimation**.

The system tracks swings, calculates rotational and linear swing speed estimates, tracks body biomechanics (elbow, knee, torso, and shoulder geometry), aligns video recordings to sensor time series, and provides interactive synchronized swing replays—all running completely locally in the browser.

---

## Operating Modes

| Mode | Sensor Data Source | Camera / Vision Source | Use Case |
|---|---|---|---|
| **Demo Mode** | Built-in realistic motion simulator | Laptop webcam or Synthetic Demo Camera | Testing, demos, presentations, and evaluation without hardware |
| **Live Hardware Mode** | Real MPU6050 readings over WebSocket (`ws://<esp-ip>:81`) | Laptop webcam or Synthetic Demo Camera | Real bat/racket practice with physical sensor mounted |

---

## Key Features

1. **Multi-Sport Swing Detection & Metrics:**
   - Pre-configured for **Cricket**, **Badminton**, and **Tennis** with customizable physical equipment dimensions (length in inches, weight in grams).
   - Real-time angular velocity ($^\circ$/s), linear acceleration ($g$), and hitting-zone estimated speed (km/h) derived from equipment length and sensor mount radius.
   - Automatic swing segmentation, peak detection, duration measurement, and consistency scoring ($0\text{--}100$).

2. **Laptop Webcam Recording & Privacy Architecture:**
   - Records directly from the laptop camera using the browser's `navigator.mediaDevices.getUserMedia` and `MediaRecorder` APIs.
   - **100% Local and Privacy-Preserving:** Video streams and recorded chunks live strictly in browser tab memory (`MediaStore`). No video data is ever transmitted to the ESP8266, the Node.js server, or any third-party cloud service.
   - **Memory & Quota Protection:** To prevent IndexedDB quota crashes and tab out-of-memory errors, videos are kept in RAM as object URLs with automatic oldest-first eviction (max 3 sessions in RAM). Users can download `.webm` / `.mp4` video files with one click, and re-attach downloaded video files later to restore synchronized replay.
   - **Synthetic Demo Camera:** Includes a canvas-driven stick-figure swing generator synchronized to sensor motion for testing video features on devices without webcams or in headless environments.

3. **Sensor-to-Video Synchronization:**
   - **Multi-Clock Problem Solved:** Resolves discrepancies between the ESP8266 `millis()` clock (which re-anchors on reboot or connection loss), browser `performance.now()`, and `MediaRecorder` media timestamps.
   - **Lower-Envelope Drift & Jitter Filtering (`SensorClockMap`):** Automatically filters network transport latency spikes and tracks clock drift across sessions without assuming zero latency.
   - **Interactive Offset Calibration:** Manual calibration slider ($-500\text{ ms}$ to $+500\text{ ms}$) lets users fine-tune audio/visual impact alignment.
   - **Configurable Swing Padding:** Set pre-swing and post-swing replay padding (e.g. $1.5\text{ s}$ before peak to $1.5\text{ s}$ after peak).
   - **Honest Alignment Uncertainty:** Displays an explicit precision estimate (e.g. $\pm 35\text{ ms}$) combining sensor sampling quantization ($50\text{ Hz} = 20\text{ ms}$), video frame quantization ($30\text{ fps} = 33.3\text{ ms}$), network jitter, and hardware pipeline delay.

4. **On-Device Computer Vision Pose Estimation:**
   - Uses **MediaPipe Pose Landmarker "lite"** running client-side via WebAssembly (`WASM`) and WebGL with automatic CPU fallback.
   - **Completely Offline:** Model binaries (`pose_landmarker_lite.task`) and vision tasks WASM binaries are served locally by the Node.js static server from `node_modules` and the `models/` directory. Zero external CDN dependencies.
   - **Interpretable 2D Biomechanical Indicators:**
     - Left & Right Elbow Bend ($^\circ$)
     - Left & Right Knee Bend ($^\circ$)
     - Torso Inclination / Spine Lean ($^\circ$)
     - Shoulder Tilt ($^\circ$)
   - **Robustness & Safety:** Includes landmark confidence/visibility filtering, low-lighting detection luminance checks, and a prominent **non-medical disclaimer** (optical 2D projections, not definitive 3D clinical biomechanics).

5. **Unified Dashboard & Swing Replay Player:**
   - Real-time webcam preview with toggleable skeleton overlay.
   - Interactive detected swing timeline bar with clickable chips.
   - Swing Replay player that automatically seeks to the swing window and highlights body posture at peak acceleration.
   - Full session reports with expandable interactive graphs (pan, zoom, reset), swing event tables, and CSV / JSON export.

---

## Folder Structure

```
├── index.html                   # Unified dashboard shell with camera, timeline & report views
├── css/style.css                # Responsive styles, camera layout, pose grid & timeline controls
├── js/
│   ├── config.js                # Per-sport physics, camera, pose and sync configuration
│   ├── sync.js                  # SensorClockMap, RecordingTimeline, swing mapping & uncertainty
│   ├── recorder.js              # VideoRecorder state machine, camera support & synthetic camera
│   ├── media-store.js           # In-memory Blob and object URL lifecycle management
│   ├── pose-math.js             # Pure 2D joint angle geometry, torso lean & lighting checks
│   ├── pose.js                  # MediaPipe Pose Landmarker browser wrapper & skeleton rendering
│   ├── analytics.js             # Sensor magnitudes, swing detection, speed & consistency math
│   ├── session.js               # Session lifecycle, segment accounting & record builder
│   ├── schema.js                # Schema validator, CSV/JSON export bundle with video/sync
│   ├── storage.js               # IndexedDB persistence for session metadata and metrics
│   ├── charts.js                # Chart.js time-series graphs with pan and zoom controls
│   ├── sensor.js                # ESP8266 WebSocket client and reconnection state machine
│   ├── simulator.js             # Demo Mode simulated sensor physics generator
│   └── app.js                   # Application controller, view routing and UI event wiring
├── models/
│   └── pose_landmarker_lite.task # MediaPipe Pose Landmarker model (~5.7 MB)
├── firmware/
│   └── esp8266_mpu6050.ino      # ESP8266 Arduino firmware streaming JSON at 50 Hz
├── scripts/
│   └── fetch-model.js           # Helper script to download pose landmarker model if missing
├── server/
│   ├── server.js                # Static HTTP server serving WASM, model tasks, and vendor files
│   └── mock-esp.js              # Mock WebSocket server for testing Live Mode without ESP8266
└── tests/
    ├── core.test.js             # Unit tests for analytics, sessions, schema, and WebSocket client
    └── video-sync-pose.test.js  # Tests for clock sync, timeline, pose geometry, and recorder
```

---

## Getting Started

### Prerequisites
- **Node.js 18+** (tested on Node 20 / 22 / 24)
- A modern browser: Google Chrome, Microsoft Edge, Brave, or Mozilla Firefox.
- *(Optional for Live Hardware)* ESP8266 NodeMCU + MPU6050 wiring and Arduino IDE.

### Installation

1. Clone or navigate to the repository directory:
   ```bash
   cd sports-performance-monitor-video
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Ensure the pose model is downloaded:
   ```bash
   npm run fetch-model
   ```

4. Start the local server:
   ```bash
   npm start
   ```

5. Open **http://localhost:8080** in your web browser.
   > **Note on Browser Permissions:** Webcams require a **Secure Context** (`http://localhost` or `https://`). When running on the laptop hosting the server, `http://localhost:8080` is automatically treated as a secure context by modern browsers.

---

## Running the Automated Test Suite

The test suite uses Node.js's built-in test runner (`node:test`). It verifies all analytical math, clock synchronization, recording timelines, pose estimation geometry, schema validation, and storage:

```bash
npm test
```

Expected output:
```
✔ magnitude
✔ normalizeSample rejects malformed data
✔ speed estimate: v = omega * r
...
✔ SensorClockMap: lower-envelope offset filters network jitter spikes
✔ RecordingTimeline: pause and resume time intervals
✔ sensorTimeToVideo and calibration offset calculation
✔ calculateJointAngle computes correct 2D interior angles
✔ VideoRecorder: state machine with mock MediaRecorder
✔ validateSessionRecord accepts optional video and sync metadata
ℹ tests 47
ℹ pass 47
ℹ fail 0
```

---

## Using Demo Mode with Video & Pose

1. Open **http://localhost:8080#setup**.
2. Select your sport (**Cricket**, **Badminton**, or **Tennis**).
3. Review equipment specifications (length in inches, weight in grams).
4. Under **Webcam & Computer Vision**:
   - Choose **Laptop Webcam** (or **Synthetic Demo Camera** if your device has no camera).
   - Ensure **Enable MediaPipe Pose Estimation** is checked.
5. Click **Start Session**.
6. On the **Live Monitoring** screen:
   - When prompted by the browser, click **Allow** for camera access.
   - Position yourself in the webcam view: watch the live skeleton overlay track shoulder, arm, and leg joints.
   - Check the **Live Pose Indicators** card for real-time elbow angles, knee angles, and torso inclination.
   - The simulator will generate swings every few seconds.
   - As swings occur, markers appear on the **Detected Swings Timeline** and chips appear below it.
7. Click any swing chip (or marker on the timeline) to immediately launch the **Synchronized Swing Replay**:
   - Video seeks automatically to $1.5\text{ s}$ before peak swing acceleration.
   - The swing replay video plays through the swing.
   - Adjust the **Offset Calibration** slider ($-500\text{ ms}$ to $+500\text{ ms}$) to compensate for camera latency.
8. Click **Stop & Generate Report** to view the full report, video replay controls, and downloadable video file (`.webm`).

---

## Live Hardware Setup (ESP8266 + MPU6050)

### Wiring Diagram

| MPU6050 Pin | NodeMCU Pin | Description |
|---|---|---|
| **VCC** | **3V3** | 3.3V power (Do NOT use 5V/Vin unless your board has a 5V regulator) |
| **GND** | **GND** | Ground connection |
| **SDA** | **D2 (GPIO4)** | I2C Data line |
| **SCL** | **D1 (GPIO5)** | I2C Clock line |
| **AD0** | **GND** | I2C address selection (`0x68`) |
| **INT** | *(Unconnected)* | Not used (polled at 50 Hz) |

### Uploading Firmware
1. Open `firmware/esp8266_mpu6050.ino` in Arduino IDE.
2. In Arduino Library Manager, install **WebSockets** by Markus Sattler (`arduinoWebSockets`).
3. Set your Wi-Fi credentials in `WIFI_SSID` and `WIFI_PASSWORD`.
4. Upload to the NodeMCU at 115200 baud.
5. In the Serial Monitor, note the printed IP address (e.g. `192.168.1.50`).
6. In the web dashboard setup, select **Live Hardware Mode**, enter the IP address and port `81`, and start the session.

---

## Video & Pose Estimation Biomechanics Limitations

1. **2D Optical Estimation vs. 3D Biomechanics:**
   Angles (elbow bend, knee bend, torso lean, shoulder tilt) are 2D geometric projections onto the camera's image plane. Foreshortening occurs if the subject is angled obliquely to the camera. These indicators provide qualitative practice feedback and are **not** medical, clinical, or orthopaedic measurements.
2. **Lighting & Occlusion:**
   Accurate pose detection requires sufficient ambient lighting and clear visibility of arms and torso. The app automatically flags frames with low lighting (`< 45` mean luma).
3. **Synchronization Limits:**
   Even with lower-envelope timing and sub-millisecond timestamps, camera sensor exposure latency and hardware video encoding introduces $50\text{--}150\text{ ms}$ of fixed delay. Use the built-in **Offset Calibration slider** to align video impact with the sensor's acceleration peak.
