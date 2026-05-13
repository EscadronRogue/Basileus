// Central numeric registry for AI decision/training code.
// Values here are defaults. Non-identity decimal coefficients are exposed to
// the policy genome as evolved numeric tuning fields.
export const AI_NUM_DEFAULTS = Object.freeze({
  N_0: 0,
  N_0_000000001: 1e-9,
  N_0_0001: 0.0001,
  N_0_001: 0.001,
  N_0_01: 0.01,
  N_0_02: 0.02,
  N_0_03: 0.03,
  N_0_035: 0.035,
  N_0_04: 0.04,
  N_0_045: 0.045,
  N_0_05: 0.05,
  N_0_06: 0.06,
  N_0_07: 0.07,
  N_0_08: 0.08,
  N_0_09: 0.09,
  N_0_1: 0.1,
  N_0_12: 0.12,
  N_0_14: 0.14,
  N_0_15: 0.15,
  N_0_16: 0.16,
  N_0_18: 0.18,
  N_0_2: 0.2,
  N_0_22: 0.22,
  N_0_24: 0.24,
  N_0_25: 0.25,
  N_0_28: 0.28,
  N_0_3: 0.3,
  N_0_32: 0.32,
  N_0_34: 0.34,
  N_0_35: 0.35,
  N_0_36: 0.36,
  N_0_38: 0.38,
  N_0_4: 0.4,
  N_0_42: 0.42,
  N_0_44: 0.44,
  N_0_45: 0.45,
  N_0_46: 0.46,
  N_0_48: 0.48,
  N_0_5: 0.5,
  N_0_55: 0.55,
  N_0_56: 0.56,
  N_0_58: 0.58,
  N_0_6: 0.6,
  N_0_62: 0.62,
  N_0_64: 0.64,
  N_0_65: 0.65,
  N_0_67: 0.67,
  N_0_7: 0.7,
  N_0_72: 0.72,
  N_0_75: 0.75,
  N_0_76: 0.76,
  N_0_8: 0.8,
  N_0_82: 0.82,
  N_0_85: 0.85,
  N_0_9: 0.9,
  N_0_95: 0.95,
  N_0_96: 0.96,
  N_1: 1,
  N_1_02: 1.02,
  N_1_05: 1.05,
  N_1_1: 1.1,
  N_1_15: 1.15,
  N_1_2: 1.2,
  N_1_25: 1.25,
  N_1_28: 1.28,
  N_1_3: 1.3,
  N_1_35: 1.35,
  N_1_4: 1.4,
  N_1_45: 1.45,
  N_1_5: 1.5,
  N_1_55: 1.55,
  N_1_6: 1.6,
  N_1_7: 1.7,
  N_1_75: 1.75,
  N_1_8: 1.8,
  N_1_85: 1.85,
  N_1_9: 1.9,
  N_2: 2,
  N_2_05: 2.05,
  N_2_1: 2.1,
  N_2_15: 2.15,
  N_2_2: 2.2,
  N_2_25: 2.25,
  N_2_3: 2.3,
  N_2_35: 2.35,
  N_2_4: 2.4,
  N_2_45: 2.45,
  N_2_5: 2.5,
  N_2_6: 2.6,
  N_2_7: 2.7,
  N_2_75: 2.75,
  N_2_8: 2.8,
  N_3: 3,
  N_3_2: 3.2,
  N_3_4: 3.4,
  N_3_5: 3.5,
  N_3_8: 3.8,
  N_4: 4,
  N_4_2: 4.2,
  N_4_4: 4.4,
  N_4_5: 4.5,
  N_5: 5,
  N_6: 6,
  N_7: 7,
  N_8: 8,
  N_9: 9,
  N_10: 10,
  N_11: 11,
  N_12: 12,
  N_13: 13,
  N_14: 14,
  N_15: 15,
  N_16: 16,
  N_17: 17,
  N_18: 18,
  N_20: 20,
  N_24: 24,
  N_30: 30,
  N_32: 32,
  N_36: 36,
  N_40: 40,
  N_45: 45,
  N_48: 48,
  N_56: 56,
  N_61: 61,
  N_80: 80,
  N_180: 180,
  N_192: 192,
  N_256: 256,
  N_512: 512,
  N_1000: 1000,
  N_1024: 1024,
  N_1536: 1536,
  N_5000: 5000,
  N_15000: 15000,
  N_16777619: 16777619,
  N_1000000000: 1000000000,
  N_2166136261: 2166136261,
  N_4294967296: 4294967296,
});

export const AI_NUM_TUNING_KEYS = Object.freeze(
  Object.entries(AI_NUM_DEFAULTS)
    .filter(([, value]) => Number.isFinite(value) && !Number.isInteger(value) && Math.abs(value) >= AI_NUM_DEFAULTS.N_0_01)
    .map(([key]) => key)
);

const AI_NUM_TUNING_KEY_SET = new Set(AI_NUM_TUNING_KEYS);
let activeNumericTuning = null;

export function withAINumericTuning(numericTuning, callback) {
  if (!numericTuning || typeof numericTuning !== 'object') {
    return callback();
  }
  const previousTuning = activeNumericTuning;
  activeNumericTuning = numericTuning;
  try {
    return callback();
  } finally {
    activeNumericTuning = previousTuning;
  }
}

function readTunedNumber(key) {
  const value = activeNumericTuning ? Number(activeNumericTuning[key]) : NaN;
  if (Number.isFinite(value)) return value;
  return AI_NUM_DEFAULTS[key];
}

export const AI_NUM = Object.freeze(Object.defineProperties(
  {},
  Object.fromEntries(Object.keys(AI_NUM_DEFAULTS).map((key) => [
    key,
    AI_NUM_TUNING_KEY_SET.has(key)
      ? {
          enumerable: true,
          get: () => readTunedNumber(key),
        }
      : {
          enumerable: true,
          value: AI_NUM_DEFAULTS[key],
        },
  ])),
));
