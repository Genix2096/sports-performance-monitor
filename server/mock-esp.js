// Mock ESP8266: speaks the SAME WebSocket protocol as the firmware, using simulated data.
// Purpose: test Live Hardware Mode end-to-end without hardware. NOT a real measurement source.
//   npm run mock-esp                 -> ws://localhost:8081 , use host "localhost" port 8081 in the app
//   node server/mock-esp.js --port 81 --sensor-fail   (simulate MPU6050 not detected)
import { WebSocketServer } from 'ws';
import { SensorModel } from '../js/simulator.js';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8081;
const sensorFail = args.includes('--sensor-fail');
const wss = new WebSocketServer({ port });
const model = new SensorModel('tennis');

const send = (o) => wss.clients.forEach((c) => c.readyState === 1 && c.send(JSON.stringify(o)));
const hello = () => ({ type: 'hello', fw: 'mock', rate: 50, accel_unit: 'g', gyro_unit: 'dps', sensor: sensorFail ? 'error' : 'ok', msg: sensorFail ? 'MPU6050 not found on I2C (check wiring)' : '' });

wss.on('connection', (ws) => {
  console.log('client connected');
  ws.send(JSON.stringify(hello()));
  ws.on('close', () => console.log('client disconnected'));
});
setInterval(() => {
  if (!wss.clients.size) return;
  if (sensorFail) return send({ type: 'status', sensor: 'error', msg: 'MPU6050 not found on I2C (check wiring)' });
  send(model.next());
}, sensorFail ? 2000 : 20);
console.log(`Mock ESP8266 listening on ws://localhost:${port}${sensorFail ? ' (sensor failure mode)' : ''}`);
