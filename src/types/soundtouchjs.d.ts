declare module 'soundtouchjs' {
  export class FifoSampleBuffer {
    readonly frameCount: number;
    readonly vector: Float32Array;
    clear(): void;
    putSamples(samples: Float32Array, position?: number, numFrames?: number): void;
    receiveSamples(output: Float32Array, numFrames?: number): void;
  }
  export class Stretch {
    overlapLength: number;
    seekLength: number;
    seekWindowLength: number;
    setParameters(sampleRate: number, sequenceMs: number, seekWindowMs: number, overlapMs: number): void;
    clearMidBuffer(): void;
  }
  export class SoundTouch {
    tempo: number;
    rate: number;
    pitch: number;
    stretch: Stretch;
    readonly inputBuffer: FifoSampleBuffer;
    readonly outputBuffer: FifoSampleBuffer;
    clear(): void;
    process(): void;
  }
}
