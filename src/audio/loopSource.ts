import type { SoundSource } from 'soundtouchjs'

/** 이보다 짧은 구간은 루프로 취급하지 않는다(≈23ms). 0 길이 루프로 무한정지하는 걸 막는다 */
export const MIN_LOOP_FRAMES = 1024

/**
 * 루프 정밀도의 핵심.
 *
 * SimpleFilter는 단조 증가하는 position으로 extract()를 호출하고, 반환한 프레임 수만큼
 * 위치를 전진시킨다. 그래서 "언제 되감을지"를 상위에서 타이머로 감시할 필요가 없다 —
 * 여기서 읽기 인덱스를 A-B 안으로 감아버리면, SoundTouch 입장에서는 끊긴 적 없는
 * 하나의 연속 스트림이다. 이음새가 오버랩-애드 안에서 자연스럽게 섞인다.
 *
 * <audio>.currentTime을 timeupdate로 되돌리는 방식이 만드는 수십 ms 틈이 여기선 아예 없다.
 */
export class LoopingBufferSource implements SoundSource {
  loop = false
  loopStartFrame = 0
  loopEndFrame = 0

  /** 다음에 읽어낼 원본 프레임. 재생 위치 계산의 기준점 */
  servedFrame = 0
  /** 루프가 아닌 상태로 파일 끝에 닿았는지 */
  ended = false

  readonly buffer: AudioBuffer
  private left: Float32Array
  private right: Float32Array
  private totalFrames: number

  constructor(buffer: AudioBuffer) {
    this.buffer = buffer
    this.left = buffer.getChannelData(0)
    this.right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : this.left
    this.totalFrames = buffer.length
  }

  private get loopable(): boolean {
    return this.loop && this.loopEndFrame - this.loopStartFrame >= MIN_LOOP_FRAMES
  }

  /** 필터의 단조 증가 position을 실제 원본 프레임으로 접는다 */
  mapFrame(position: number): number {
    if (!this.loopable) return position
    if (position < this.loopStartFrame) return position
    const len = this.loopEndFrame - this.loopStartFrame
    const offset = (position - this.loopStartFrame) % len
    return this.loopStartFrame + (offset < 0 ? offset + len : offset)
  }

  extract(target: Float32Array, numFrames: number, position: number): number {
    const { left, right, totalFrames } = this
    const loopable = this.loopable
    let written = 0
    let p = position

    // 경계(파일 끝 · 루프 끝 · 루프 시작)에 걸리면 잘라서 여러 번 복사한다
    while (written < numFrames) {
      const src = this.mapFrame(p)
      if (src >= totalFrames) break

      const boundary = loopable
        ? src < this.loopStartFrame
          ? this.loopStartFrame
          : Math.min(this.loopEndFrame, totalFrames)
        : totalFrames

      const run = Math.min(numFrames - written, boundary - src)
      if (run <= 0) break

      for (let i = 0; i < run; i++) {
        const o = (written + i) * 2
        target[o] = left[src + i]
        target[o + 1] = right[src + i]
      }
      written += run
      p += run
    }

    this.servedFrame = this.mapFrame(p)
    this.ended = written < numFrames && !loopable
    return written
  }
}
