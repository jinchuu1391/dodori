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

  /**
   * 필터 position → 접기 전 프레임으로 옮기는 보정값. 평소엔 0.
   *
   * position을 (position − A) % 구간길이 로 접기 때문에, 몇 바퀴 돈 뒤에 구간 길이가 바뀌면
   * 같은 position이 구간 안 엉뚱한 곳으로 접힌다(재생 중 B를 옮기면 소리·헤드가 튀던 원인).
   * 구간을 바꿀 때 "다음 position이 지금 읽던 자리(servedFrame)를 가리키도록" 이 값을 다시 잡는다.
   */
  private positionOffset = 0
  /** 마지막 extract가 끝난 position — 다음 extract가 시작할 자리 */
  private nextPosition = 0

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

  /**
   * 재생 중에 구간을 바꾸거나 루프를 끈다. 읽던 자리에서 끊김 없이 이어진다 —
   * SimpleFilter를 clear()하지 않으므로 소리도 튀지 않는다.
   * 읽던 자리가 새 구간 밖이면 어디로 갈지는 호출하는 쪽(엔진)이 seek로 정한다.
   */
  setLoop(loop: boolean, startFrame: number, endFrame: number) {
    this.positionOffset = this.servedFrame - this.nextPosition
    this.loop = loop
    this.loopStartFrame = startFrame
    this.loopEndFrame = endFrame
  }

  /** SimpleFilter.sourcePosition = frame 과 함께 부른다. 보정값도 비운다 */
  seek(frame: number) {
    this.servedFrame = frame
    this.nextPosition = frame
    this.positionOffset = 0
  }

  /**
   * 필터 position(소수 가능)이 가리키는 원본 프레임. 메트로놈이 "지금 들리는 곳"을 알 때 쓴다.
   * setLoop의 보정값까지 반영하므로 extract가 읽은 자리와 같은 곳을 가리킨다.
   */
  frameAtPosition(position: number): number {
    return this.mapFrame(position + this.positionOffset)
  }

  /** 접기 전 프레임(단조 증가)을 실제 원본 프레임으로 접는다 */
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
    // 소수 position이 들어오면 left[52341.73] = undefined → NaN이 SoundTouch를 오염시켜 무음이 된다.
    // 엔진은 정수로 seek하지만, 혹시 새는 경로가 있어도 여기서 막는다
    let p = Math.floor(position + this.positionOffset)

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
    this.nextPosition = position + written
    this.ended = written < numFrames && !loopable
    return written
  }
}
