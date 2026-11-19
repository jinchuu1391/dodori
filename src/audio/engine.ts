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
    this.source.servedFrame = clamped
    this.restingFrame = clamped
    this.anchorFrame = clamped
    if (this.ctx) this.anchorCtxTime = this.ctx.currentTime
  }

  /* ---------- 구간 루프 ---------- */

  /** endSec이 null이면 루프 해제 */
  setLoop(startSec: number | null, endSec: number | null) {
    if (!this.source || !this.buffer) return
    const sr = this.buffer.sampleRate
    if (startSec === null || endSec === null || endSec <= startSec) {
      this.source.loop = false
      return
    }
    this.source.loopStartFrame = Math.max(0, Math.round(startSec * sr))
    this.source.loopEndFrame = Math.min(this.buffer.length, Math.round(endSec * sr))
    this.source.loop = true

    const head = this.currentFrame()
    if (head < this.source.loopStartFrame || head >= this.source.loopEndFrame) {
      this.seekFrame(this.source.loopStartFrame)
    }
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

  getPositionSec(): number {
    if (!this.buffer) return 0
    return this.currentFrame() / this.buffer.sampleRate
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
