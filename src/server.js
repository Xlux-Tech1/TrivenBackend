import app from './app.js';
import { config } from './config/config.js';
import connectDB from './config/database.js';
import initAttendanceCron from './modules/attendance/attendance.cron.js';
import smx from './modules/shipmaxx/shipmaxx.service.js';
import dns from 'dns';

let server;
dns.setServers(['8.8.8.8', '8.8.4.4']);

connectDB().then(async () => {
  initAttendanceCron();

  // Pre-warm ShipMaxx token so first API call doesn't hit rate limit
  try {
    await smx.login();
    console.log('[ShipMaxx] Token pre-loaded on startup ✓');
  } catch (err) {
    console.warn('[ShipMaxx] Startup pre-login failed (will retry on first request):', err.message);
  }

  server = app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port} in ${config.env} mode`);
  });
});

const exitHandler = () => {
  if (server) {
    server.close(() => {
      console.log('Server closed');
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
};

const unexpectedErrorHandler = (error) => {
  console.error(error);
  exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', () => {
  console.log('SIGTERM received');
  if (server) {
    server.close();
  }
});
