import { SimpleFilter, SoundTouch, getWebAudioNode } from 'soundtouchjs'
import { LoopingBufferSource } from './loopSource'

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

    const node = getWebAudioNode(
      ctx,
      filter,
      () => {
        // 오디오 콜백마다 앵커 갱신. 사이 프레임은 ctx.currentTime으로 보간한다
        this.anchorCtxTime = ctx.currentTime
        this.anchorFrame = source.servedFrame
      },
      BUFFER_SIZE,
    )

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
    if (s.loop && (this.restingFrame < s.loopStartFrame || this.restingFrame >= s.loopEndFrame)) {
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
    this.seekFrame(Math.round(sec * this.buffer.sampleRate))
  }

  private seekFrame(frame: number) {
    if (!this.filter || !this.buffer || !this.source) return
    const clamped = Math.max(0, Math.min(frame, this.buffer.length - 1))
    // sourcePosition 대입은 내부 파이프를 clear한다 = 진짜 seek
    this.filter.sourcePosition = clamped
    this.source.seek(clamped)
    this.restingFrame = clamped
    this.anchorFrame = clamped
    this.smooth = null
    if (this.ctx) this.anchorCtxTime = this.ctx.currentTime
  }

  /* ---------- 구간 루프 ---------- */

  /** endSec이 null이면 루프 해제 */
  setLoop(startSec: number | null, endSec: number | null) {
    if (!this.source || !this.buffer) return
    const s = this.source
    const sr = this.buffer.sampleRate
    // 재생 중에 바꿔도 읽던 자리에서 이어진다(LoopingBufferSource.setLoop 참고)
    if (startSec === null || endSec === null || endSec <= startSec) {
      s.setLoop(false, s.loopStartFrame, s.loopEndFrame)
      return
    }
    const a = Math.max(0, Math.round(startSec * sr))
    const b = Math.min(this.buffer.length, Math.round(endSec * sr))
    s.setLoop(true, a, b)

    // 지금 위치가 새 구간 밖이면 A로. 재생 중에는 실제로 읽고 있는 자리(servedFrame)로 판단한다 —
    // currentFrame()은 화면용 추정이라 ±100ms쯤 흔들려서, 루프가 막 감긴 직후엔 A 앞으로
    // 잘못 나와 멀쩡한 재생을 A로 되돌려 버린다.
    const head = this.playing ? s.servedFrame : this.restingFrame
    if (head < a || head >= b) this.seekFrame(a)
  }

  get loopEnabled() {
    return this.source?.loop ?? false
  }

  /* ---------- 속도 · 키 ---------- */

  setSpeed(speed: number) {
    this.tempo = speed
    if (this.soundTouch) this.soundTouch.tempo = speed
  }

  setPitchSemitones(semitones: number) {
    if (this.soundTouch) this.soundTouch.pitchSemitones = semitones
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
    const frame = this.anchorFrame + (elapsed - lead) * this.tempo * sr
    return this.source.mapFrame(Math.max(0, Math.min(frame, this.buffer.length)))
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
    const pred = s.mapFrame(Math.min(this.smooth.frame + advance, this.buffer.length))

    // 루프 되감기를 사이에 두고 앵커와 예측이 갈렸으면 구간 길이만큼 접어서 비교한다
    let err = raw - pred
    const len = s.loopEndFrame - s.loopStartFrame
    if (s.loop && len > 0 && Math.abs(err) > len / 2) err -= Math.sign(err) * len

    let frame: number
    if (Math.abs(err) > SNAP_SEC * sr) {
      frame = raw
    } else {
      const pull = err * (1 - Math.exp(-dt / SMOOTH_TAU_SEC))
      const limit = advance * MAX_CORRECTION
      frame = s.mapFrame(Math.min(pred + Math.max(-limit, Math.min(limit, pull)), this.buffer.length))
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
