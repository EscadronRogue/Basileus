import { Worker as ThreadWorker } from 'node:worker_threads';

function toNodeWorkerUrl(url) {
  const workerUrl = url instanceof URL ? new URL(url.href) : new URL(String(url), import.meta.url);
  if (workerUrl.pathname.endsWith('/evaluation.worker.js')) {
    workerUrl.pathname = workerUrl.pathname.replace('/evaluation.worker.js', '/evaluation.node-worker.js');
  }
  return workerUrl;
}

export function installNodeWorkerShim() {
  if (typeof process === 'undefined' || !process.versions?.node) return;
  if (globalThis.Worker?.__basileusNodeWorkerShim) return;

  class NodeWorkerShim {
    static __basileusNodeWorkerShim = true;

    constructor(url) {
      this.worker = new ThreadWorker(toNodeWorkerUrl(url), { type: 'module', execArgv: [] });
      this.listeners = new Map();
    }

    addEventListener(type, listener, options = {}) {
      const once = typeof options === 'object' && Boolean(options.once);
      const wrapped = type === 'message'
        ? (data) => listener({ data })
        : (error) => listener(error);
      this.listeners.set(listener, { type, wrapped });
      if (once) this.worker.once(type, wrapped);
      else this.worker.on(type, wrapped);
    }

    removeEventListener(type, listener) {
      const record = this.listeners.get(listener);
      if (!record) return;
      this.worker.off(record.type || type, record.wrapped);
      this.listeners.delete(listener);
    }

    postMessage(message) {
      this.worker.postMessage(message);
    }

    terminate() {
      return this.worker.terminate();
    }
  }

  globalThis.Worker = NodeWorkerShim;
}
