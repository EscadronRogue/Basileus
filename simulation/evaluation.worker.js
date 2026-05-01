import { evaluateWorkerPayload } from './evolution.js';

self.addEventListener('message', (event) => {
  try {
    const result = evaluateWorkerPayload(event.data || {});
    self.postMessage({
      ok: true,
      result,
    });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: {
        message: error?.message || 'Unknown evaluation worker error',
        stack: error?.stack || '',
      },
    });
  }
});
