/** essentia.js 0.1.3은 타입 선언이 패키지 루트(CommonJS)에만 있어서, 쓰는 ES 빌드만 따로 선언한다 */
declare module 'essentia.js/dist/essentia-wasm.es.js' {
  export const EssentiaWASM: unknown
}

declare module 'essentia.js/dist/essentia.js-core.es.js' {
  /** emscripten std::vector<float> 핸들 */
  export interface VectorFloat {
    size(): number
    delete(): void
  }
  export default class Essentia {
    constructor(wasm: unknown)
    arrayToVector(a: Float32Array): VectorFloat
    vectorToArray(v: VectorFloat): Float32Array
    RhythmExtractor2013(
      signal: VectorFloat,
      maxTempo?: number,
      method?: string,
      minTempo?: number,
    ): { bpm: number; ticks: VectorFloat; confidence: number; estimates: VectorFloat; bpmIntervals: VectorFloat }
  }
}
