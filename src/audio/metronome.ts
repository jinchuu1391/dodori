import type { BeatGrid } from '../types'

/**
 * 메트로놈 클릭 믹서. 오디오 콜백이 "출력 샘플 i에서 들리는 원본 프레임"을 넘겨 주면
 * 박 경계를 넘는 샘플에서 클릭을 시작해 출력에 더한다.
 *
 * 클릭은 SoundTouch를 거치지 않고 출력 단에서 섞는다. 앞단(원본)에 넣으면 음악과 같이
 * 밀려서 박에는 맞지만, 느리게 재생할 때 SoundTouch가 구간을 반복·건너뛰어 클릭이 두 번
 * 들리거나 빠진다. 뒷단에서 섞으면 클릭은 늘 한 번씩, 일정한 간격으로 난다.
 *
 * 박 위치는 곡의 시간축에 고정돼 있다(BeatGrid). 그래서 속도를 늦추면 클릭도 느려지고,
 * 구간 반복으로 B→A로 감겨도 박이 곡에 붙어 있다.
 */

const CLICK_SEC = 0.03
/** 되감긴 직후(구간 반복 · seek) 첫 샘플이 박에서 이만큼 안쪽이면 그 박을 친다 */
const LANDING_TOLERANCE_SEC = 0.004

function makeClick(sampleRate: number, freq: number, gain: number): Float32Array {
  const n = Math.round(sampleRate * CLICK_SEC)
  const out = new Float32Array(n)
  const attack = Math.round(sampleRate * 0.001)
  for (let i = 0; i < n; i++) {
    const env = (i < attack ? i / attack : 1) * Math.exp(-i / (sampleRate * 0.006))
    out[i] = gain * env * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  }
  return out
}

interface Voice {
  sound: Float32Array
  at: number
}

export class ClickMixer {
  grid: BeatGrid | null = null
  volume = 0.8
  /** 지금까지 친 클릭 수(테스트·디버그용) */
  clickCount = 0
  /** 마지막으로 친 클릭이 강박이었나(테스트·디버그용) */
  lastAccent = false

  private readonly accent: Float32Array
  private readonly normal: Float32Array
  private voices: Voice[] = []
  private prevFrame = NaN
  private prevBeat = 0
  private readonly sourceRate: number

  /**
   * @param outputRate 출력(오디오 컨텍스트) 샘플레이트 — 클릭 소리 길이용
   * @param sourceRate 원본 프레임의 샘플레이트 — 박 간격(프레임) 계산용
   */
  constructor(outputRate: number, sourceRate: number) {
    this.sourceRate = sourceRate
    this.accent = makeClick(outputRate, 1760, 0.9)
    this.normal = makeClick(outputRate, 1175, 0.6)
  }

  /** seek · 재생 시작 때. 이어지던 위치를 잊고, 울리던 클릭도 끊는다 */
  reset() {
    this.prevFrame = NaN
    this.voices = []
  }

  /**
   * @param frames 출력 샘플마다 들리는 원본 프레임(구간 반복이면 접힌 값). NaN = 아직 소리 없음
   */
  mix(left: Float32Array, right: Float32Array, frames: Float64Array, n: number, maxAdvance = Infinity) {
    const g = this.grid
    if (g && g.bpm > 0) this.findBeats(g, frames, n, maxAdvance)
    this.render(left, right, n)
  }

  private findBeats(g: BeatGrid, frames: Float64Array, n: number, maxAdvance: number) {
    const interval = (60 / g.bpm) * this.sourceRate
    const anchor = g.anchorSec * this.sourceRate
    const tolerance = LANDING_TOLERANCE_SEC * this.sourceRate
    for (let i = 0; i < n; i++) {
      const f = frames[i]
      if (Number.isNaN(f)) {
        this.prevFrame = NaN
        continue
      }
      const pos = (f - anchor) / interval
      const beat = Math.floor(pos)
      const advance = f - this.prevFrame
      const continuous = advance >= 0 && advance <= maxAdvance
      // 앞으로 흐르다 박 경계를 넘었거나, 되감겨서(또는 처음으로) 박 바로 위에 떨어졌을 때
      const hit = continuous ? beat > this.prevBeat : (pos - beat) * interval < tolerance
      if (hit) {
        const bpb = Math.max(1, Math.round(g.beatsPerBar))
        const isAccent = ((beat % bpb) + bpb) % bpb === 0
        this.voices.push({ sound: isAccent ? this.accent : this.normal, at: -i })
        this.clickCount++
        this.lastAccent = isAccent
      }
      this.prevFrame = f
      this.prevBeat = beat
    }
  }

  /** voice.at = 이 블록 시작 기준 클릭 소리의 읽기 위치(음수면 블록 중간에서 시작) */
  private render(left: Float32Array, right: Float32Array, n: number) {
    if (this.voices.length === 0) return
    const vol = this.volume
    for (const v of this.voices) {
      for (let i = Math.max(0, -v.at); i < n; i++) {
        const k = v.at + i
        if (k >= v.sound.length) break
        const s = v.sound[k] * vol
        left[i] += s
        right[i] += s
      }
      v.at += n
    }
    this.voices = this.voices.filter((v) => v.at < v.sound.length)
  }
}
