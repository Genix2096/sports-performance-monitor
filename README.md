# Smart Sports Equipment Performance Monitor

A web dashboard for a college embedded-systems project. An **MPU6050** (accelerometer + gyroscope) on an **ESP8266 NodeMCU** is attached to a cricket bat, badminton racket or tennis racket. The app shows live motion data, detects swings, **estimates** swing speed, draws graphs, creates session reports and saves sessions in the browser.

Two modes:

| Mode | Data source |
|---|---|
| **Demo Mode** | Built-in simulator (clearly labelled *simulated*). No hardware needed. |
| **Live Hardware Mode** | Real MPU6050 samples sent by the ESP8266 over WebSocket. Never silently falls back to simulated data. |

## Features
- Home dashboard, session setup, live monitoring, session report, session history.
- Live acceleration / angular-velocity numbers and rolling 10 s graphs; full session kept separately.
- Start / Pause / Resume / Stop. Paused time is **not** counted in the active duration.
- Swing detection (per-sport, configurable), estimated swing speed, consistency score.
- History in **IndexedDB**: open, delete (with confirmation), export JSON / CSV, import JSON (validated, duplicate IDs skipped).
- Works from a phone browser on the same Wi-Fi.

## Folder structure
```
index.html            single page app shell
css/style.css
js/config.js          ESP8266 address/port, per-sport thresholds & radius  <-- edit here
js/analytics.js       magnitudes, swing detector, speed estimate, consistency (pure functions)
js/session.js         session state machine, active-time accounting, record building
js/simulator.js       Demo Mode sensor simulator
js/sensor.js          WebSocket client + protocol parser + connection states
js/schema.js          record validation, import parsing, CSV/JSON export
js/storage.js         IndexedDB
js/charts.js          Chart.js wrappers
js/app.js             routing and UI
firmware/esp8266_mpu6050.ino
server/server.js      tiny static server (no dependencies)
server/mock-esp.js    fake ESP8266 for testing Live Mode without hardware
tests/core.test.js    automated tests
```

## Prerequisites
- Node.js 18+ (tested with Node 24)
- Arduino IDE with ESP8266 board support (for the firmware)

## Install and start
```
npm install
npm start
```
Open **http://localhost:8080** . The console also prints a `Phone / LAN` address. Chart.js is served from `node_modules`, so no internet is needed. Do not open `index.html` by double-clicking (ES modules need http).

Run the tests: `npm test`

## Using Demo Mode
1. Open the app, pick a sport, press **Start Session**.
2. Keep **Demo Mode** selected and press **Start Session**.
3. Watch the graphs; a simulated swing occurs every few seconds. Try Pause / Resume, **Reset simulator**, then **Stop & Generate Report**.

## Phone access
1. Laptop and phone on the same Wi-Fi.
2. Run `npm start` on the laptop and open the printed `http://<laptop-ip>:8080` on the phone (`localhost` on a phone means the phone itself). Allow Node through the Windows firewall if asked.
3. Pages are served over plain `http`, so the browser may connect to the ESP8266's `ws://` socket. Do not put the app behind `https` (browsers block `ws://` from https pages).

The phone connects **directly** to the ESP8266 (`ws://<esp-ip>:81`); no relay is required. Sessions saved on the phone are separate from those on the laptop.

## Configure the ESP8266 address
Edit `js/config.js` (`esp.host`, `esp.port`) — or just type the address on the **New Session** screen (Live Hardware Mode); it is remembered in the browser. The port must match `WS_PORT` in the firmware (default 81). The ESP8266 prints its IP on the Serial Monitor (115200 baud). Give it a fixed/reserved IP in your router for convenience.

## Hardware
Required Arduino libraries (Library Manager): **WebSockets** by Markus Sattler (arduinoWebSockets). `ESP8266WiFi` and `Wire` come with the ESP8266 core. No MPU6050 library is needed (registers are read directly).

Board: *NodeMCU 1.0 (ESP-12E Module)*.

| MPU6050 | NodeMCU | Note |
|---|---|---|
| VCC | **3V3** | The MPU6050 chip is 3.3 V. Many GY-521 boards also tolerate 5 V through an onboard regulator, but this project assumes **3.3 V** — do not use 5 V/Vin unless you know your breakout has a regulator. |
| GND | GND | |
| SDA | **D2 (GPIO4)** | |
| SCL | **D1 (GPIO5)** | |
| AD0 | GND | I2C address 0x68 |
| INT | – | not used |

### Upload the firmware
1. Open `firmware/esp8266_mpu6050.ino`.
2. Replace `WIFI_SSID` and `WIFI_PASSWORD` placeholders (do not commit real credentials).
3. Select the board and COM port, upload, open Serial Monitor at 115200.
4. Keep the module still for about a second at power-up (gyro bias calibration).
5. The Serial Monitor prints `connected. Open the app and use address: x.x.x.x port 81`.
LED (active low): solid = OK, fast blink = no Wi-Fi, slow blink = sensor error.

## WebSocket protocol (ESP8266 → browser)
JSON text frames on `ws://<esp-ip>:81`. **Units: acceleration in g, angular velocity in degrees/second (dps).** Timestamp `ts` = milliseconds since ESP8266 boot (`millis()`); `seq` increments per sample. Sample rate: **50 Hz** (20 ms; one ~110-byte message per sample, ~5 KB/s). Sensor ranges: ±16 g, ±2000 dps, low-pass about 44 Hz.

```json
{"type":"hello","fw":"1.0.0","rate":50,"accel_unit":"g","gyro_unit":"dps","sensor":"ok","msg":"","ip":"192.168.1.50"}
{"type":"status","sensor":"error","msg":"MPU6050 not found on I2C (check wiring ...)"}
{"type":"sample","seq":1234,"ts":24680,"ax":0.012,"ay":-0.034,"az":0.998,"gx":1.25,"gy":-0.40,"gz":0.10}
```
- `hello` is sent when a client connects; `status` is sent every 2 s while the sensor is in error and when its state changes.
- The browser treats 3 s of silence as **connection lost** and reconnects automatically every 3 s.
- Malformed or non-numeric samples are ignored and counted; they never crash the app.
- If `ts` is missing but `seq` is present, the parser derives time from `seq` × 20 ms.
The test suite checks that the firmware's JSON format string is parsed by the frontend parser.

Browser connection states: Disconnected, Connecting, Connected, Sensor unavailable, Connection lost.

## Test Live Mode without hardware
`npm run mock-esp` starts a fake ESP8266 (simulated data, same protocol) on port 8081. In New Session choose Live Hardware, host `localhost`, port `8081`. To simulate an MPU6050 failure run `node server/mock-esp.js --port 8082 --sensor-fail`. This only tests the software path — it is **not** hardware verification.

## Troubleshooting
- **"Could not reach the ESP8266"**: check the IP on the Serial Monitor, same Wi-Fi network, port 81, and that the page is `http://`. Some routers isolate Wi-Fi clients (AP isolation).
- **"Sensor unavailable" / `MPU6050 not found`**: check VCC→3V3, GND, SDA→D2, SCL→D1, solder joints, AD0 to GND. Try an I2C scanner sketch; address should be 0x68 (0x69 if AD0 high — then change `MPU_ADDR`).
- **Unexpected WHO_AM_I**: counterfeit chips report 0x70/0x72/0x98 (accepted); anything else usually means a different chip or bad wiring.
- **Constant swings / none**: tune `swing` thresholds in `js/config.js`.
- **Graphs missing**: start with `npm start` and use the printed address.

## Sessions, export and backup
History is stored in this browser's IndexedDB. It is **not synchronised between devices** and **is lost if you clear site data** (or use private browsing). Use **Export** (per session) or **Export all** in History to create portable JSON backups, and **Import JSON** on any device to restore. Imports are validated against the schema; sessions whose ID already exists are skipped. Report pages also export CSV (`t_ms, ax, ay, az, gx, gy, gz, magnitudes`). Sessions longer than 60,000 stored samples (~20 min at 50 Hz) are thinned for storage; statistics still use every sample.

## How the analytics work (and their limits)
- `|a| = √(ax²+ay²+az²)` (g), `|ω| = √(gx²+gy²+gz²)` (°/s).
- **Swing detection** (`SwingDetector`): a candidate starts when |ω| ≥ `startDps`, ends when |ω| ≤ `endDps`. It counts only if peak |ω| ≥ `minPeakDps`, peak |a| ≥ `minPeakG` and duration is within limits. After a candidate the gyro must drop below `endDps` and a cooldown must pass (no double counting). Gaps in samples abort a candidate. It is a simple threshold method, **not perfectly accurate**; the defaults are guesses to tune with real data.
- **Estimated swing speed** = peak |ω| (rad/s) × assumed effective radius `radiusM` (cricket 0.85 m, badminton 0.6 m, tennis 0.75 m). This approximates the speed of a point at that distance from the rotation axis. It depends on mounting position and assumes pure rotation; it is **not ball speed**, impact force or shot accuracy. Angular velocity (°/s) and linear speed (km/h) are different quantities. The ±2000 °/s sensor range also caps very fast swings.
- **Consistency**: CV = sample standard deviation / mean of peak |ω| across swings; score = `round(100 × (1 − min(CV, 0.5)/0.5))`. Needs ≥ 3 swings, otherwise "Insufficient data".
- Active duration comes from sample timestamps accepted while running; paused time, long gaps (>2 s) and device reboots are not counted.
- If the sensor stops sending data in Live Mode, the session timer stops advancing (it is data-driven).
