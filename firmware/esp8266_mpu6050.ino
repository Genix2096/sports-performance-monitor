/*
 * Smart Sports Equipment Performance Monitor - ESP8266 + MPU6050 firmware
 * ---------------------------------------------------------------------------
 * Board   : ESP8266 NodeMCU (Arduino IDE, "NodeMCU 1.0 (ESP-12E Module)")
 * Sensor  : MPU6050 on I2C, read directly via Wire (no sensor library needed)
 * Library : "WebSockets" by Markus Sattler (arduinoWebSockets) - install from Library Manager
 *
 * WIRING (MPU6050 is a 3.3 V part - power it from 3V3, NOT from Vin/5V):
 *   MPU6050 VCC -> NodeMCU 3V3
 *   MPU6050 GND -> NodeMCU GND
 *   MPU6050 SDA -> NodeMCU D2 (GPIO4)
 *   MPU6050 SCL -> NodeMCU D1 (GPIO5)
 *   MPU6050 AD0 -> GND (I2C address 0x68)   | INT not used
 *
 * PROTOCOL (JSON text frames over WebSocket, port WS_PORT). Units: g and degrees/second.
 *   {"type":"hello","fw":"1.0.0","rate":50,"accel_unit":"g","gyro_unit":"dps","sensor":"ok","msg":"","ip":"x.x.x.x"}
 *   {"type":"status","sensor":"ok"|"error","msg":"..."}           (sent every 2 s while sensor is in error)
 *   {"type":"sample","seq":N,"ts":ms_since_boot,"ax":..,"ay":..,"az":..,"gx":..,"gy":..,"gz":..}
 *
 * Configure Wi-Fi below. NEVER commit real credentials.
 */
#include <ESP8266WiFi.h>
#include <WebSocketsServer.h>
#include <Wire.h>

// ====== USER SETTINGS ======================================================
const char* WIFI_SSID = "YOUR_WIFI_NAME";         // <-- replace
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD"; // <-- replace
const uint16_t WS_PORT = 81;                      // must match "port" in js/config.js
const uint32_t SAMPLE_INTERVAL_MS = 20;           // 20 ms = 50 Hz (must match "rate" below & config.js)
// ===========================================================================

#define FW_VERSION "1.0.0"
#define SAMPLE_RATE_HZ 50
#define PIN_SDA 4  // D2
#define PIN_SCL 5  // D1

// Shared with the web app's parser (js/sensor.js). Keep field names unchanged.
#define SAMPLE_JSON_FMT "{\"type\":\"sample\",\"seq\":%lu,\"ts\":%lu,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"gx\":%.2f,\"gy\":%.2f,\"gz\":%.2f}"

// MPU6050 registers
const uint8_t MPU_ADDR = 0x68;
const uint8_t REG_SMPLRT_DIV = 0x19, REG_CONFIG = 0x1A, REG_GYRO_CONFIG = 0x1B, REG_ACCEL_CONFIG = 0x1C;
const uint8_t REG_ACCEL_XOUT_H = 0x3B, REG_PWR_MGMT_1 = 0x6B, REG_WHO_AM_I = 0x75;
const float ACCEL_LSB_PER_G = 2048.0f;   // +-16 g
const float GYRO_LSB_PER_DPS = 16.4f;    // +-2000 dps

WebSocketsServer webSocket(WS_PORT);

bool sensorOk = false;
const char* sensorMsg = "";
uint8_t readFailures = 0;
float gyroBias[3] = {0, 0, 0};
uint32_t seqNo = 0;
uint32_t lastSampleMs = 0, lastInitTryMs = 0, lastStatusMs = 0, lastLedMs = 0, lastWifiLogMs = 0;
bool wsStarted = false, ledState = false;
wl_status_t lastWifiStatus = WL_IDLE_STATUS;

// ---- MPU6050 helpers --------------------------------------------------------
bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuReadRaw(int16_t* v /* ax ay az temp gx gy gz */) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)MPU_ADDR, 14, (int)true) != 14) return false;
  for (int i = 0; i < 7; i++) {
    uint8_t hi = Wire.read();
    uint8_t lo = Wire.read();
    v[i] = (int16_t)((hi << 8) | lo);
  }
  return true;
}

bool mpuInit() {
  Wire.beginTransmission(MPU_ADDR);
  if (Wire.endTransmission() != 0) {
    sensorMsg = "MPU6050 not found on I2C (check wiring SDA=D2 SCL=D1 3V3 GND)";
    return false;
  }
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(REG_WHO_AM_I);
  Wire.endTransmission(false);
  Wire.requestFrom((int)MPU_ADDR, 1, (int)true);
  uint8_t who = Wire.available() ? Wire.read() : 0;
  // 0x68 = genuine MPU6050; some clones report 0x70/0x72/0x98.
  if (who != 0x68 && who != 0x70 && who != 0x72 && who != 0x98) {
    Serial.printf("[MPU] unexpected WHO_AM_I = 0x%02X\n", who);
    sensorMsg = "Unexpected WHO_AM_I value - device is not an MPU6050?";
    return false;
  }
  mpuWrite(REG_PWR_MGMT_1, 0x80);  // device reset
  delay(100);                      // startup only, not in the sampling loop
  if (!mpuWrite(REG_PWR_MGMT_1, 0x01) ||        // wake up, PLL with X gyro clock
      !mpuWrite(REG_SMPLRT_DIV, 0x00) ||
      !mpuWrite(REG_CONFIG, 0x03) ||            // digital low-pass ~44 Hz
      !mpuWrite(REG_GYRO_CONFIG, 0x18) ||       // +-2000 dps
      !mpuWrite(REG_ACCEL_CONFIG, 0x18)) {      // +-16 g
    sensorMsg = "MPU6050 configuration failed";
    return false;
  }
  delay(50);
  // Gyro bias calibration: keep the module still while powering up.
  float sum[3] = {0, 0, 0};
  int n = 0;
  for (int i = 0; i < 100; i++) {
    int16_t r[7];
    if (mpuReadRaw(r)) { sum[0] += r[4]; sum[1] += r[5]; sum[2] += r[6]; n++; }
    delay(5);
    yield();
  }
  if (n > 50) for (int i = 0; i < 3; i++) gyroBias[i] = sum[i] / n / GYRO_LSB_PER_DPS;
  Serial.printf("[MPU] OK (WHO_AM_I=0x%02X), gyro bias %.2f %.2f %.2f dps\n", who, gyroBias[0], gyroBias[1], gyroBias[2]);
  sensorMsg = "";
  return true;
}

// ---- WebSocket messages ------------------------------------------------------
void sendHelloTo(uint8_t num) {
  char buf[256];
  snprintf(buf, sizeof(buf),
           "{\"type\":\"hello\",\"fw\":\"" FW_VERSION "\",\"rate\":%d,\"accel_unit\":\"g\",\"gyro_unit\":\"dps\",\"sensor\":\"%s\",\"msg\":\"%s\",\"ip\":\"%s\"}",
           SAMPLE_RATE_HZ, sensorOk ? "ok" : "error", sensorMsg, WiFi.localIP().toString().c_str());
  webSocket.sendTXT(num, buf);
}

void broadcastStatus() {
  char buf[160];
  snprintf(buf, sizeof(buf), "{\"type\":\"status\",\"sensor\":\"%s\",\"msg\":\"%s\"}", sensorOk ? "ok" : "error", sensorMsg);
  webSocket.broadcastTXT(buf);
}

void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] client %u connected from %s\n", num, webSocket.remoteIP(num).toString().c_str());
      sendHelloTo(num);
      break;
    case WStype_DISCONNECTED:
      Serial.printf("[WS] client %u disconnected\n", num);
      break;
    default:
      break;
  }
}

void sendSample() {
  int16_t r[7];
  if (!mpuReadRaw(r)) {
    if (++readFailures >= 5) {
      sensorOk = false;
      sensorMsg = "MPU6050 stopped responding";
      Serial.println("[MPU] read failures - will retry init");
      broadcastStatus();
    }
    return;
  }
  readFailures = 0;
  float ax = r[0] / ACCEL_LSB_PER_G, ay = r[1] / ACCEL_LSB_PER_G, az = r[2] / ACCEL_LSB_PER_G;
  float gx = r[4] / GYRO_LSB_PER_DPS - gyroBias[0];
  float gy = r[5] / GYRO_LSB_PER_DPS - gyroBias[1];
  float gz = r[6] / GYRO_LSB_PER_DPS - gyroBias[2];
  if (webSocket.connectedClients() == 0) return;  // nobody listening: skip formatting/sending
  char buf[160];
  int len = snprintf(buf, sizeof(buf), SAMPLE_JSON_FMT, (unsigned long)(++seqNo), (unsigned long)millis(), ax, ay, az, gx, gy, gz);
  webSocket.broadcastTXT(buf, len);
}

// ---- Wi-Fi and status LED (non-blocking) -----------------------------------------
void handleWifi(uint32_t now) {
  wl_status_t st = WiFi.status();
  if (st != lastWifiStatus) {
    lastWifiStatus = st;
    if (st == WL_CONNECTED) {
      Serial.printf("[WiFi] connected. Open the app and use address: %s  port %u\n", WiFi.localIP().toString().c_str(), WS_PORT);
      if (!wsStarted) {
        webSocket.begin();
        webSocket.onEvent(onWsEvent);
        wsStarted = true;
      }
    } else {
      Serial.println("[WiFi] disconnected - auto-reconnect active");
    }
  }
  if (st != WL_CONNECTED && now - lastWifiLogMs > 5000) {
    lastWifiLogMs = now;
    Serial.printf("[WiFi] connecting to \"%s\" (status %d)...\n", WIFI_SSID, (int)st);
  }
  // LED (active low): solid = all OK, fast blink = no Wi-Fi, slow blink = sensor error
  uint32_t period = st != WL_CONNECTED ? 150 : (!sensorOk ? 800 : 0);
  if (period == 0) digitalWrite(LED_BUILTIN, LOW);
  else if (now - lastLedMs >= period) {
    lastLedMs = now;
    ledState = !ledState;
    digitalWrite(LED_BUILTIN, ledState ? LOW : HIGH);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("\n\nSmart Sports Monitor firmware " FW_VERSION);
  pinMode(LED_BUILTIN, OUTPUT);
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(400000);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  sensorOk = mpuInit();
  if (!sensorOk) Serial.printf("[MPU] INIT FAILED: %s\n", sensorMsg);
  lastInitTryMs = millis();
}

void loop() {
  uint32_t now = millis();
  handleWifi(now);
  if (wsStarted) webSocket.loop();

  if (!sensorOk) {
    if (now - lastInitTryMs >= 2000) {
      lastInitTryMs = now;
      sensorOk = mpuInit();
      Serial.println(sensorOk ? "[MPU] sensor recovered" : "[MPU] still not detected");
      if (wsStarted) broadcastStatus();
    } else if (wsStarted && now - lastStatusMs >= 2000) {
      lastStatusMs = now;
      broadcastStatus();
    }
    return;
  }

  if (now - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = now;
    if (wsStarted) sendSample();
  }
}
