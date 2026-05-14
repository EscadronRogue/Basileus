import { NETWORK_INPUT_SIZE } from './features.js';

const DEFAULT_HIDDEN_SIZES = [96, 64];
const OUTPUT_SIZE = 2; // policy logit, value
const ADAM_BETA1 = 0.9;
const ADAM_BETA2 = 0.999;
const ADAM_EPSILON = 1e-8;

function makeLocalRng(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randn(rng) {
  const left = Math.max(1e-12, rng());
  const right = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
}

function createLayer(inputSize, outputSize, activation, rng) {
  const weights = new Float64Array(inputSize * outputSize);
  const biases = new Float64Array(outputSize);
  const scale = Math.sqrt(2 / Math.max(1, inputSize));
  for (let i = 0; i < weights.length; i += 1) {
    weights[i] = randn(rng) * scale;
  }
  return {
    inputSize,
    outputSize,
    activation,
    weights,
    biases,
    weightMoments: new Float64Array(weights.length),
    weightVelocities: new Float64Array(weights.length),
    biasMoments: new Float64Array(outputSize),
    biasVelocities: new Float64Array(outputSize),
  };
}

export function createNetwork(options = {}) {
  const inputSize = options.inputSize || NETWORK_INPUT_SIZE;
  const hiddenSizes = Array.isArray(options.hiddenSizes) && options.hiddenSizes.length
    ? options.hiddenSizes.slice()
    : DEFAULT_HIDDEN_SIZES.slice();
  const rng = makeLocalRng(options.seed || 1);
  const sizes = [inputSize, ...hiddenSizes, OUTPUT_SIZE];
  const layers = [];
  for (let index = 1; index < sizes.length; index += 1) {
    layers.push(createLayer(
      sizes[index - 1],
      sizes[index],
      index === sizes.length - 1 ? 'linear' : 'relu',
      rng,
    ));
  }
  return {
    version: 1,
    inputSize,
    hiddenSizes,
    outputSize: OUTPUT_SIZE,
    step: 0,
    layers,
  };
}

export function forward(network, input) {
  let activation = input;
  const activations = [input];
  const preActivations = [];

  for (const layer of network.layers) {
    const z = new Float64Array(layer.outputSize);
    const next = new Float64Array(layer.outputSize);
    for (let outIndex = 0; outIndex < layer.outputSize; outIndex += 1) {
      let value = layer.biases[outIndex];
      const offset = outIndex * layer.inputSize;
      for (let inIndex = 0; inIndex < layer.inputSize; inIndex += 1) {
        value += activation[inIndex] * layer.weights[offset + inIndex];
      }
      z[outIndex] = value;
      next[outIndex] = layer.activation === 'relu' ? Math.max(0, value) : value;
    }
    preActivations.push(z);
    activations.push(next);
    activation = next;
  }

  return {
    policy: activation[0],
    value: activation[1],
    activations,
    preActivations,
  };
}

function softmax(logits, temperature = 1) {
  const safeTemperature = Math.max(1e-6, Number(temperature) || 1);
  const max = Math.max(...logits);
  const exp = logits.map((logit) => Math.exp((logit - max) / safeTemperature));
  const total = exp.reduce((sum, value) => sum + value, 0) || 1;
  return exp.map((value) => value / total);
}

export function selectActionWithNetwork(network, inputs, rng = Math.random, options = {}) {
  if (!inputs.length) return { index: -1, probabilities: [], outputs: [] };
  const outputs = inputs.map((input) => forward(network, input));
  const logits = outputs.map((entry) => entry.policy);
  const temperature = options.temperature ?? 1;
  const probabilities = softmax(logits, temperature);

  if (options.greedy || temperature === 0) {
    let bestIndex = 0;
    for (let index = 1; index < logits.length; index += 1) {
      if (logits[index] > logits[bestIndex]) bestIndex = index;
    }
    return { index: bestIndex, probabilities, outputs };
  }

  let pick = rng();
  for (let index = 0; index < probabilities.length; index += 1) {
    pick -= probabilities[index];
    if (pick <= 0) return { index, probabilities, outputs };
  }
  return { index: probabilities.length - 1, probabilities, outputs };
}

function createGradients(network) {
  return network.layers.map((layer) => ({
    weights: new Float64Array(layer.weights.length),
    biases: new Float64Array(layer.biases.length),
  }));
}

function backward(network, cache, outputGradient, gradients) {
  let gradActivation = new Float64Array(outputGradient);

  for (let layerIndex = network.layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layer = network.layers[layerIndex];
    const grad = gradients[layerIndex];
    const previousActivation = cache.activations[layerIndex];
    const z = cache.preActivations[layerIndex];
    const gradZ = new Float64Array(layer.outputSize);

    for (let outIndex = 0; outIndex < layer.outputSize; outIndex += 1) {
      gradZ[outIndex] = layer.activation === 'relu' && z[outIndex] <= 0
        ? 0
        : gradActivation[outIndex];
      grad.biases[outIndex] += gradZ[outIndex];
    }

    const nextGradActivation = new Float64Array(layer.inputSize);
    for (let outIndex = 0; outIndex < layer.outputSize; outIndex += 1) {
      const offset = outIndex * layer.inputSize;
      for (let inIndex = 0; inIndex < layer.inputSize; inIndex += 1) {
        const weightIndex = offset + inIndex;
        grad.weights[weightIndex] += gradZ[outIndex] * previousActivation[inIndex];
        nextGradActivation[inIndex] += gradZ[outIndex] * layer.weights[weightIndex];
      }
    }
    gradActivation = nextGradActivation;
  }
}

function adamStep(network, gradients, learningRate, scale) {
  network.step = (network.step || 0) + 1;
  const biasCorrection1 = 1 - (ADAM_BETA1 ** network.step);
  const biasCorrection2 = 1 - (ADAM_BETA2 ** network.step);

  for (let layerIndex = 0; layerIndex < network.layers.length; layerIndex += 1) {
    const layer = network.layers[layerIndex];
    const grad = gradients[layerIndex];

    for (let i = 0; i < layer.weights.length; i += 1) {
      const g = grad.weights[i] * scale;
      layer.weightMoments[i] = ADAM_BETA1 * layer.weightMoments[i] + (1 - ADAM_BETA1) * g;
      layer.weightVelocities[i] = ADAM_BETA2 * layer.weightVelocities[i] + (1 - ADAM_BETA2) * g * g;
      const mHat = layer.weightMoments[i] / biasCorrection1;
      const vHat = layer.weightVelocities[i] / biasCorrection2;
      layer.weights[i] -= learningRate * mHat / (Math.sqrt(vHat) + ADAM_EPSILON);
    }

    for (let i = 0; i < layer.biases.length; i += 1) {
      const g = grad.biases[i] * scale;
      layer.biasMoments[i] = ADAM_BETA1 * layer.biasMoments[i] + (1 - ADAM_BETA1) * g;
      layer.biasVelocities[i] = ADAM_BETA2 * layer.biasVelocities[i] + (1 - ADAM_BETA2) * g * g;
      const mHat = layer.biasMoments[i] / biasCorrection1;
      const vHat = layer.biasVelocities[i] / biasCorrection2;
      layer.biases[i] -= learningRate * mHat / (Math.sqrt(vHat) + ADAM_EPSILON);
    }
  }
}

export function trainBatch(network, transitions, options = {}) {
  const usable = transitions.filter((entry) => entry?.inputs?.length && Number.isInteger(entry.chosenIndex));
  if (!usable.length) return { loss: 0, policyLoss: 0, valueLoss: 0, count: 0 };

  const learningRate = Number(options.learningRate) || 0.001;
  const entropyBeta = Number(options.entropyBeta) || 0.01;
  const gradients = createGradients(network);
  let policyLoss = 0;
  let valueLoss = 0;
  let gradientApplications = 0;

  for (const transition of usable) {
    const outputs = transition.inputs.map((input) => forward(network, input));
    const logits = outputs.map((entry) => entry.policy);
    const probabilities = softmax(logits, options.temperature ?? 1);
    const chosen = Math.max(0, Math.min(transition.chosenIndex, outputs.length - 1));
    const targetReturn = Number(transition.return) || 0;
    const value = outputs[chosen].value;
    const advantage = targetReturn - value;
    const uniform = 1 / outputs.length;

    policyLoss += -advantage * Math.log(Math.max(1e-9, probabilities[chosen]));
    valueLoss += 0.5 * advantage * advantage;

    for (let index = 0; index < outputs.length; index += 1) {
      const policyGradient = advantage * (probabilities[index] - (index === chosen ? 1 : 0))
        + entropyBeta * (probabilities[index] - uniform);
      const valueGradient = index === chosen ? (value - targetReturn) : 0;
      backward(network, outputs[index], [policyGradient, valueGradient], gradients);
      gradientApplications += 1;
    }
  }

  adamStep(network, gradients, learningRate, 1 / Math.max(1, gradientApplications));
  return {
    loss: (policyLoss + valueLoss) / usable.length,
    policyLoss: policyLoss / usable.length,
    valueLoss: valueLoss / usable.length,
    count: usable.length,
  };
}

function typedArrayToPlain(array) {
  return Array.from(array, (value) => Number(value));
}

export function serializeNetwork(network) {
  return {
    version: network.version || 1,
    inputSize: network.inputSize,
    hiddenSizes: network.hiddenSizes.slice(),
    outputSize: network.outputSize,
    step: network.step || 0,
    layers: network.layers.map((layer) => ({
      inputSize: layer.inputSize,
      outputSize: layer.outputSize,
      activation: layer.activation,
      weights: typedArrayToPlain(layer.weights),
      biases: typedArrayToPlain(layer.biases),
      weightMoments: typedArrayToPlain(layer.weightMoments),
      weightVelocities: typedArrayToPlain(layer.weightVelocities),
      biasMoments: typedArrayToPlain(layer.biasMoments),
      biasVelocities: typedArrayToPlain(layer.biasVelocities),
    })),
  };
}

function toFloat64Array(values, size) {
  const out = new Float64Array(size);
  for (let index = 0; index < Math.min(values?.length || 0, size); index += 1) {
    out[index] = Number(values[index]) || 0;
  }
  return out;
}

export function deserializeNetwork(raw) {
  if (!raw || !Array.isArray(raw.layers)) {
    throw new Error('Invalid neural model file.');
  }
  return {
    version: raw.version || 1,
    inputSize: raw.inputSize || NETWORK_INPUT_SIZE,
    hiddenSizes: Array.isArray(raw.hiddenSizes) ? raw.hiddenSizes.slice() : DEFAULT_HIDDEN_SIZES.slice(),
    outputSize: raw.outputSize || OUTPUT_SIZE,
    step: Number(raw.step) || 0,
    layers: raw.layers.map((layer) => {
      const weightSize = Number(layer.inputSize) * Number(layer.outputSize);
      return {
        inputSize: Number(layer.inputSize),
        outputSize: Number(layer.outputSize),
        activation: layer.activation === 'relu' ? 'relu' : 'linear',
        weights: toFloat64Array(layer.weights, weightSize),
        biases: toFloat64Array(layer.biases, Number(layer.outputSize)),
        weightMoments: toFloat64Array(layer.weightMoments, weightSize),
        weightVelocities: toFloat64Array(layer.weightVelocities, weightSize),
        biasMoments: toFloat64Array(layer.biasMoments, Number(layer.outputSize)),
        biasVelocities: toFloat64Array(layer.biasVelocities, Number(layer.outputSize)),
      };
    }),
  };
}
