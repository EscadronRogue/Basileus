self.addEventListener('message', async (event) => {
  const { type, config } = event.data || {};
  if (type !== 'run' && type !== 'train') return;

  try {
    const runner = type === 'train'
      ? (await import('./evolution.js')).runEvolutionTraining
      : (await import('./engine.js')).runSimulationBatch;
    const result = await runner(config, (progress) => {
      self.postMessage({ type: 'progress', progress, mode: type === 'train' ? 'training' : 'simulation' });
    });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: {
        message: error?.message || 'Unknown simulation error',
        stack: error?.stack || '',
      },
    });
  }
});
