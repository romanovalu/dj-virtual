declare module 'essentia.js/dist/essentia-wasm.es.js' {
  export const EssentiaWASM: unknown;
}
declare module 'essentia.js/dist/essentia.js-core.es.js' {
  interface EssentiaVector {
    delete(): void;
    size(): number;
  }
  export default class Essentia {
    constructor(wasm: unknown, isDebug?: boolean);
    version: string;
    arrayToVector(a: Float32Array): EssentiaVector;
    vectorToArray(v: EssentiaVector): Float32Array;
    RhythmExtractor2013(signal: EssentiaVector, maxTempo?: number, method?: string, minTempo?: number): {
      bpm: number;
      ticks: EssentiaVector;
      confidence: number;
      estimates: EssentiaVector;
      bpmIntervals: EssentiaVector;
    };
    KeyExtractor(audio: EssentiaVector, averageDetuningCorrection?: boolean, frameSize?: number, hopSize?: number, hpcpSize?: number, maxFrequency?: number, maximumSpectralPeaks?: number, minFrequency?: number, pcpThreshold?: number, profileType?: string, sampleRate?: number): {
      key: string;
      scale: string;
      strength: number;
    };
    Danceability(signal: EssentiaVector, maxTau?: number, minTau?: number, sampleRate?: number): { danceability: number; dfa: EssentiaVector };
  }
}
