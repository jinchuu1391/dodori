/**
 * soundtouchjs 0.1.30은 타입을 배포하지 않는다.
 * 우리가 실제로 쓰는 표면만 선언한다 (dist/soundtouch.js 기준).
 */
declare module 'soundtouchjs' {
  /** SimpleFilter가 샘플을 당겨가는 인터페이스 — LoopingBufferSource가 이걸 구현한다 */
  export interface SoundSource {
    /** target은 인터리브 스테레오. 실제로 채운 프레임 수를 반환 */
    extract(target: Float32Array, numFrames: number, position: number): number
  }

  export class SoundTouch {
    tempo: number
    rate: number
    pitch: number
    pitchSemitones: number
  }

  export class SimpleFilter {
    constructor(sourceSound: SoundSource, pipe: SoundTouch, callback?: () => void)
    /** 소스에서 소비한 프레임 수(단조 증가). 대입하면 내부 파이프를 clear한다 = seek */
    sourcePosition: number
    position: number
    clear(): void
    extract(target: Float32Array, numFrames: number): number
    onEnd(): void
  }

  export function getWebAudioNode(
    context: BaseAudioContext,
    filter: SimpleFilter,
    sourcePositionCallback?: (position: number) => void,
    bufferSize?: number,
  ): ScriptProcessorNode

  export class WebAudioBufferSource implements SoundSource {
    constructor(buffer: AudioBuffer)
    extract(target: Float32Array, numFrames: number, position: number): number
  }
}
