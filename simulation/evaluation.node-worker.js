import { parentPort } from 'node:worker_threads';
import { evaluateWorkerPayload } from './evolution.js';

parentPort.on('message', (payload) => {
  try {
    parentPort.postMessage({ ok: true, result: evaluateWorkerPayload(payload || {}) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: error?.message || 'Unknown Node evaluation worker error',
        stack: error?.stack || '',
      },
    });
  }
});
