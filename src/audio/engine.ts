import { SimpleFilter, SoundTouch } from 'soundtouchjs'
import type { BeatGrid } from '../types'
import { LoopingBufferSource } from './loopSource'
import { ClickMixer } from './metronome'
import { measureStretchOffset } from './stretchOffset'

/**
 * ScriptProcessor 블록 크기. 크면 글리치에 강하고 작으면 반응이 빠르다.
 * 4096 = 44.1kHz에서 약 93ms — soundtouchjs 기본값이자 실사용 타협점.
 *
 * ScriptProcessorNode는 deprecated이고 메인 스레드에서 돈다. 설계 문서 06절의
 * "교체 여지"가 바로 이 지점 — 음질/글리치가 문제되면 이 노드만 AudioWorklet으로 바꾼다.
 */
const BUFFER_SIZE = 4096

/**
 * SoundTouch 내부 시퀀스 윈도우만큼 입력이 출력보다 앞서 소비된다.
 * 재생 헤드를 눈에 맞추기 위한 보정값(정확한 수치가 아니라 경험적 근사).
 */
const EXTRA_LEAD_SEC = 0.05

/**
 * 화면용 재생 위치 평활. 오디오 콜백(약 93ms마다)의 앵커는 SoundTouch가 입력을 고르지 않은
 * 덩어리로 읽어 가서 콜백마다 앞뒤로 수십~수백 ms 튄다. 그대로 그리면 헤드가 초당 10번가량
 * 움찔거리고 뒤로도 간다. 화면 위치는 흐른 시간만큼 고르게 나아가고, 앵커 쪽으로는
 * 시정수 SMOOTH_TAU_SEC로 천천히 끌려가게 한다.
 */
const SMOOTH_TAU_SEC = 0.5
/** 보정은 원래 진행량의 ±이 비율까지 — 헤드가 뒤로 가거나 확 튀지 않는다 */
const MAX_CORRECTION = 0.25
/** 앵커와 이만큼 넘게 벌어지면 따라가지 않고 바로 맞춘다(예상 못 한 점프 대비) */
const SNAP_SEC = 0.5

export type EngineEvents = {
  /** 루프가 아닌 상태로 곡 끝에 도달 */
  onEnded?: () => void
}

/**
 * 설계 문서 그림 4의 신호 그래프.
 *   LoopingBufferSource → SoundTouch(속도·피치) → Gain → Analyser → 출력
 *
 * 루프는 소스 단계에서 처리하므로 이 위 계층에는 "언제 되감을지"를 아는 코드가 없다.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null

  private node: ScriptProcessorNode | null = null
  private soundTouch: SoundTouch | null = null
  private filter: SimpleFilter | null = null
  private source: LoopingBufferSource | null = null
  private buffer: AudioBuffer | null = null

  private playing = false
  private tempo = 1
  private pitch = 0

  /*
   * 메트로놈. 출력 샘플 n에서 들리는 원본 위치를 "seek한 position + tempo·n + stretchOffset"으로
   * 계산해 박을 찾는다(stretchOffset.ts 참고). 속도·키를 바꾸면 지금 위치에서 이어지게 다시 잡는다.
   */
  private mixer: ClickMixer | null = null
  private metronomeOn = false
  private clickP0 = 0
  private clickOut = 0
  /** 이 position보다 앞(= seek 직후 SoundTouch가 아직 소리를 못 낸 구간)은 클릭하지 않는다 */
  private clickGuard = 0
  private stretchOffset = 0
  private stretchOffsetStale = true
  private readonly clickFrames = new Float64Array(BUFFER_SIZE)

  /** 마지막 audioprocess 시점의 (컨텍스트 시각, 소스 프레임) — 사이를 보간해서 헤드를 그린다 */
  private anchorCtxTime = 0
  private anchorFrame = 0
  /** 정지 중이거나 seek 직후의 위치 */
  private restingFrame = 0
  /** 화면용 평활 위치와 그 시각(performance.now). seek·재생 시작 때 비운다 */
  private smooth: { frame: number; at: number } | null = null

  private events: EngineEvents = {}

  /* ---------- 수명주기 ---------- */

  /** 브라우저 자동재생 정책상 컨텍스트 생성은 아무 때나, resume은 사용자 제스처에서 */
  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx
    const ctx = new AudioContext()
    const gain = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    gain.connect(analyser)
    analyser.connect(ctx.destination)
    this.ctx = ctx
    this.gain = gain
    this.analyser = analyser
    return ctx
  }

  on(events: EngineEvents) {
    this.events = events
  }

  /** File → ArrayBuffer → AudioBuffer. 디코딩된 버퍼를 그대로 돌려준다(피크 계산에 쓰려고) */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureContext()
    return await ctx.decodeAudioData(data)
  }

  /** 디코딩된 곡을 엔진에 올린다. 이전 곡은 정리된다 */
  load(buffer: AudioBuffer) {
    const ctx = this.ensureContext()
    this.unload()

    const source = new LoopingBufferSource(buffer)
    const soundTouch = new SoundTouch()
    soundTouch.tempo = this.tempo
    const filter = new SimpleFilter(source, soundTouch, () => this.handleEnded())

    // soundtouchjs의 getWebAudioNode와 같은 일 + 메트로놈 클릭을 출력 단에서 섞는다
    const node = ctx.createScriptProcessor(BUFFER_SIZE, 2, 2)
    const samples = new Float32Array(BUFFER_SIZE * 2)
    node.onaudioprocess = (e) => {
      const left = e.outputBuffer.getChannelData(0)
      const right = e.outputBuffer.getChannelData(1)
      const n = filter.extract(samples, BUFFER_SIZE)
      // 오디오 콜백마다 앵커 갱신. 사이 프레임은 ctx.currentTime으로 보간한다
      this.anchorCtxTime = ctx.currentTime
      this.anchorFrame = source.servedFrame
      if (n === 0) filter.onEnd()
      for (let i = 0; i < n; i++) {
        left[i] = samples[i * 2]
        right[i] = samples[i * 2 + 1]
      }
      left.fill(0, n)
      right.fill(0, n)
      this.mixClicks(left, right, n)
      this.clickOut += n
    }
    this.mixer = new ClickMixer(ctx.sampleRate, buffer.sampleRate)
    this.mixer.grid = this.pendingGrid
    this.mixer.volume = this.pendingClickVolume
    this.clickP0 = 0
    this.clickOut = 0
    this.clickGuard = 0
    this.stretchOffsetStale = true

    this.buffer = buffer
    this.source = source
    this.soundTouch = soundTouch
    this.filter = filter
    this.node = node
    this.restingFrame = 0
    this.anchorFrame = 0
    this.anchorCtxTime = ctx.currentTime
  }

  unload() {
    if (this.playing) this.pause()
    this.node?.disconnect()
    if (this.node) this.node.onaudioprocess = null
    this.node = null
    this.filter = null
    this.soundTouch = null
    this.source = null
    this.buffer = null
    this.mixer = null
    this.playing = false
    this.restingFrame = 0
    this.smooth = null
  }

  async dispose() {
    this.unload()
    await this.ctx?.close()
    this.ctx = null
    this.gain = null
    this.analyser = null
  }

  /* ---------- 트랜스포트 ---------- */

  get isLoaded() {
    return this.buffer !== null
  }

  get isPlaying() {
    return this.playing
  }

  get durationSec() {
    return this.buffer ? this.buffer.duration : 0
  }

  async play() {
    if (!this.node || !this.gain || !this.ctx || this.playing) return
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    // 루프가 켜져 있는데 헤드가 구간 밖이면 A로 들어간다
    const s = this.source!
    if (s.loop && !s.containsFrame(this.restingFrame)) {
      this.seekFrame(s.loopStartFrame)
    }
    this.anchorCtxTime = this.ctx.currentTime
    this.anchorFrame = this.restingFrame
    this.smooth = null
    this.node.connect(this.gain)
    this.playing = true
  }

  pause() {
    if (!this.node || !this.playing) return
    // 들리던 지점에서 멈춰야 재개가 자연스럽다 — 파이프라인 선행분을 되감아 고정
    const frame = this.currentFrame()
    this.node.disconnect()
    this.playing = false
    this.seekFrame(frame)
  }

  async toggle() {
    if (this.playing) this.pause()
    else await this.play()
  }

  seekSec(sec: number) {
    if (!this.buffer) return
    const frame = Math.round(sec * this.buffer.sampleRate)
    const source = this.source
    this.seekFrame(source?.hasGaps ? source.mapFrame(source.loopPosition(Math.max(frame, source.loopStartFrame))) : frame)
  }

  private seekFrame(frame: number) {
    if (!this.filter || !this.buffer || !this.source) return
    // 반드시 정수로. 일시정지는 소수인 추정 위치(currentFrame)로 되돌아오는데, 소수 position이면
    // 소스가 left[52341.73]처럼 읽어 NaN이 SoundTouch에 들어가고, 다음 seek까지 출력 전체가 NaN(무음)이 된다
    const clamped = Math.max(0, Math.min(Math.round(frame), this.buffer.length - 1))
    // sourcePosition 대입은 내부 파이프를 clear한다 = 진짜 seek
    this.filter.sourcePosition = clamped
    this.source.seek(clamped)
    this.restingFrame = clamped
    this.anchorFrame = clamped
    this.smooth = null
    if (this.ctx) this.anchorCtxTime = this.ctx.currentTime
    // 필터가 비워졌으니 클릭 시계도 여기서 다시 센다
    this.clickP0 = clamped
    this.clickOut = 0
    this.clickGuard = clamped
    this.mixer?.reset()
  }

  /* ---------- 구간 루프 ---------- */

  /** endSec이 null이면 루프 해제 */
  setLoop(startSec: number | null, endSec: number | null) {
    this.setLoopRanges(startSec !== null && endSec !== null ? [{ startSec, endSec }] : [])
  }

  setLoopRanges(ranges: readonly { startSec: number; endSec: number }[]) {
    if (!this.source || !this.buffer) return
    const s = this.source
    const sr = this.buffer.sampleRate
    const length = this.buffer.length
    s.setLoopRanges(ranges.map(({ startSec, endSec }) => ({
      start: Math.max(0, Math.round(startSec * sr)),
      end: Math.min(length, Math.round(endSec * sr)),
    })))

    // 지금 위치가 새 구간 밖이면 A로. 재생 중에는 실제로 읽고 있는 자리(servedFrame)로 판단한다 —
    // currentFrame()은 화면용 추정이라 ±100ms쯤 흔들려서, 루프가 막 감긴 직후엔 A 앞으로
    // 잘못 나와 멀쩡한 재생을 A로 되돌려 버린다.
    const head = this.playing ? s.servedFrame : this.restingFrame
    if (s.loop && !s.containsFrame(head)) this.seekFrame(s.loopStartFrame)
    if (this.smooth && s.loop && !s.containsFrame(this.smooth.frame)) this.smooth = null
  }

  get loopEnabled() {
    return this.source?.loop ?? false
  }

  /* ---------- 속도 · 키 ---------- */

  setSpeed(speed: number) {
    this.reanchorClicks(() => {
      this.tempo = speed
      if (this.soundTouch) this.soundTouch.tempo = speed
    })
  }

  setPitchSemitones(semitones: number) {
    this.reanchorClicks(() => {
      this.pitch = semitones
      if (this.soundTouch) this.soundTouch.pitchSemitones = semitones
    })
  }

  /* ---------- 메트로놈 ---------- */

  private pendingGrid: BeatGrid | null = null
  private pendingClickVolume = 0.8

  /** grid가 null이면 박이 없으니 켜져 있어도 치지 않는다 */
  setMetronome(on: boolean, grid: BeatGrid | null) {
    this.metronomeOn = on
    this.pendingGrid = grid
    if (this.mixer) this.mixer.grid = grid
  }

  setMetronomeVolume(v: number) {
    this.pendingClickVolume = v
    if (this.mixer) this.mixer.volume = v
  }

  /** 지금까지 친 클릭 수 — 테스트용 */
  get clickCount(): number {
    return this.mixer?.clickCount ?? 0
  }

  /**
   * 속도·키 변경. 지금 들리는 위치에서 클릭 시계가 끊기지 않게 새 기울기·보정값으로 다시 잡는다.
   * (SoundTouch 안에 이미 들어 있는 소리는 예전 설정으로 만든 것이라 잠깐은 몇 ms 어긋날 수 있다)
   */
  private reanchorClicks(change: () => void) {
    const before = this.clickP0 + this.tempo * this.clickOut + this.stretchOffset
    change()
    this.stretchOffsetStale = true
    // 꺼져 있으면 재는 비용은 아끼되, 시계는 항상 새 속도로 다시 잡는다
    // (안 그러면 예전 속도로 센 clickOut에 새 속도를 곱하게 된다)
    if (this.metronomeOn) this.refreshStretchOffset()
    this.clickP0 = before - this.stretchOffset
    this.clickOut = 0
  }

  /** 속도·키에 맞는 SoundTouch 지연을 잰다(캐시됨, 처음엔 십수 ms) */
  private refreshStretchOffset() {
    if (!this.stretchOffsetStale || !this.buffer) return
    this.stretchOffset = measureStretchOffset(this.tempo, this.pitch, this.buffer.sampleRate)
    this.stretchOffsetStale = false
  }

  private mixClicks(left: Float32Array, right: Float32Array, n: number) {
    const mixer = this.mixer
    const source = this.source
    if (!mixer || !source || !this.buffer || !this.metronomeOn || !mixer.grid) return
    if (this.stretchOffsetStale) {
      // 오디오 콜백 안에서 재는 건 피하고 싶지만, 켜자마자 한 번뿐이다(캐시)
      const before = this.clickP0 + this.tempo * this.clickOut + this.stretchOffset
      this.refreshStretchOffset()
      if (this.clickOut > 0) {
        this.clickP0 = before - this.stretchOffset
        this.clickOut = 0
      }
    }
    const frames = this.clickFrames
    const len = this.buffer.length
    for (let i = 0; i < n; i++) {
      const fp = this.clickP0 + this.tempo * (this.clickOut + i) + this.stretchOffset
      const f = fp < this.clickGuard ? NaN : source.frameAtPosition(fp)
      frames[i] = f >= len ? NaN : f
    }
    mixer.mix(left, right, frames, n, source.hasGaps ? this.tempo + 0.25 : Infinity)
  }

  setVolume(v: number) {
    this.ensureContext()
    if (this.gain) this.gain.gain.value = v
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser
  }

  /* ---------- 재생 위치 ---------- */

  /**
   * 현재 재생 프레임(추정). 오디오 콜백 앵커 + ctx 시계 보간이라
   * 60fps로 부드럽게 움직인다. 절대 오차는 파이프라인 지연 한 블록 수준(±100ms 안팎).
   */
  private currentFrame(): number {
    if (!this.playing || !this.ctx || !this.buffer || !this.source) return this.restingFrame
    const sr = this.buffer.sampleRate
    const elapsed = this.ctx.currentTime - this.anchorCtxTime
    const lead = BUFFER_SIZE / this.ctx.sampleRate + this.outputLatency() + EXTRA_LEAD_SEC
    const source = this.source
    const frame = source.loopPosition(this.anchorFrame) + (elapsed - lead) * this.tempo * sr
    return source.mapFrame(source.hasGaps ? Math.max(source.loopStartFrame, frame) : Math.max(0, Math.min(frame, this.buffer.length)))
  }

  /**
   * 화면에 그릴 재생 위치. currentFrame()을 그대로 쓰면 떨리므로 평활한다(SMOOTH_TAU_SEC 참고).
   * 재생 시작 직후에는 파이프라인 지연만큼 앵커가 뒤에 있어서, 헤드는 제자리에서 조금 느리게
   * 출발해 실제 소리에 맞춰 간다 — 뒤로 튀었다가 출발하지 않는다.
   */
  private displayFrame(): number {
    if (!this.playing || !this.buffer || !this.source) return this.restingFrame
    const raw = this.currentFrame()
    const now = performance.now()
    if (!this.smooth) {
      this.smooth = { frame: this.restingFrame, at: now }
      return this.restingFrame
    }

    const s = this.source
    const sr = this.buffer.sampleRate
    const dt = Math.max(0, (now - this.smooth.at) / 1000)
    const advance = dt * this.tempo * sr
    const projected = s.loopPosition(this.smooth.frame) + advance
    const pred = s.mapFrame(s.hasGaps ? projected : Math.min(projected, this.buffer.length))

    // 루프 되감기를 사이에 두고 앵커와 예측이 갈렸으면 구간 길이만큼 접어서 비교한다
    let err = s.loopPosition(raw) - s.loopPosition(pred)
    const len = s.loopLength
    if (s.loop && len > 0 && Math.abs(err) > len / 2) err -= Math.sign(err) * len

    let frame: number
    if (Math.abs(err) > SNAP_SEC * sr) {
      frame = raw
    } else {
      const pull = err * (1 - Math.exp(-dt / SMOOTH_TAU_SEC))
      const limit = advance * MAX_CORRECTION
      const corrected = s.loopPosition(pred) + Math.max(-limit, Math.min(limit, pull))
      frame = s.mapFrame(s.hasGaps ? Math.max(s.loopStartFrame, corrected) : Math.min(corrected, this.buffer.length))
    }
    this.smooth = { frame, at: now }
    return frame
  }

  getPositionSec(): number {
    if (!this.buffer) return 0
    return this.displayFrame() / this.buffer.sampleRate
  }

  private outputLatency(): number {
    if (!this.ctx) return 0
    const ctx = this.ctx as AudioContext & { outputLatency?: number }
    return typeof ctx.outputLatency === 'number' ? ctx.outputLatency : (ctx.baseLatency ?? 0)
  }

  private handleEnded() {
    if (!this.playing) return
    this.node?.disconnect()
    this.playing = false
    this.restingFrame = 0
    this.seekFrame(0)
    this.events.onEnded?.()
  }
}

/** 앱 전체에서 하나. 오디오 컨텍스트는 여러 개 만들 이유가 없다 */
export const engine = new AudioEngine()
