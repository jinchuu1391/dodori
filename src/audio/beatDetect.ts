/**
 * 자동 박 감지 — 오디오에서 BeatGrid(BPM · 첫 박)를 추정한다.
 *
 * 1) Essentia RhythmExtractor2013(multifeature)로 박 위치(ticks)와 BPM을 얻는다.
 *    (Essentia 호출은 워커에서 하고, 여기는 주입받은 함수로만 부른다 — 테스트에서 Node로 돌리려고)
 * 2) ticks는 처음 몇 초 수렴 구간이 흔들리고, 분석 hop(512샘플 ≈ 11.6ms) 단위로 양자화돼 있다.
 *    메트로놈 격자는 템포 고정이므로 ticks에 "직선"(t = a + k·P)을 맞춰 BPM과 위상을 구한다.
 * 3) 격자의 박마다 원본 신호에서 가장 가까운 어택(1ms 해상도)을 찾아 BPM · 위상을 다시 맞춘다.
 *    Essentia ticks는 실제 어택보다 10–20ms 이르게 나오는 경향이 있어서, 이걸 안 하면 클릭이
 *    음악보다 살짝 앞서 들린다.
 *
 * 강박(마디의 1박)은 추정하지 않는다. 분석 시작점 이후 첫 박을 1박으로 둔다.
 */

/** RhythmExtractor2013은 44.1kHz 입력을 가정한다 */
export const ESSENTIA_SR = 44100
/** 이보다 짧으면 박 추적이 수렴하지 못한다. 구간이 짧으면 앞뒤로 넓혀 분석한다 */
export const MIN_ANALYSIS_SEC = 12

export interface RhythmResult {
  bpm: number
  /** 박 위치 [s] */
  ticks: ArrayLike<number>
  /** multifeature 신뢰도 0–5.32. <1 낮음, 1–1.5 보통, 1.5–3.5 좋음, >3.5 아주 좋음 */
  confidence: number
}

export type RhythmFn = (signal44k: Float32Array) => RhythmResult

export interface DetectedGrid {
  bpm: number
  /** 분석 신호 기준 [s] */
  anchorSec: number
  confidence: number
}

/** [from, to) 프레임을 모노로 섞는다 */
export function toMono(channels: Float32Array[], from: number, to: number): Float32Array {
  const n = Math.max(0, to - from)
  const out = new Float32Array(n)
  const g = 1 / channels.length
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] += ch[from + i] * g
  }
  return out
}

/** 선형 보간 리샘플. 박 추적용이라 앨리어싱은 신경 쓰지 않는다 */
export function resampleLinear(x: Float32Array, srIn: number, srOut: number): Float32Array {
  if (srIn === srOut) return x
  const n = Math.floor((x.length * srOut) / srIn)
  const out = new Float32Array(n)
  const step = srIn / srOut
  for (let i = 0; i < n; i++) {
    const p = i * step
    const j = Math.floor(p)
    const f = p - j
    const a = x[j]
    const b = j + 1 < x.length ? x[j + 1] : a
    out[i] = a + (b - a) * f
  }
  return out
}

/**
 * (박 번호 k, 시각 t) 점들에 직선 t = phase + k·period 를 맞춘다. 반복할 때마다 허용 오차를
 * tols 순서대로 좁혀, 수렴 전의 엉뚱한 박이나 엇박을 빼고 다시 맞춘다.
 */
function robustLine(
  ks: number[],
  ts: number[],
  period: number,
  phase: number,
  tols: number[],
): { period: number; phase: number } | null {
  for (const tol of tols) {
    let n = 0
    let sk = 0
    let st = 0
    for (let i = 0; i < ks.length; i++) {
      if (Math.abs(ts[i] - phase - ks[i] * period) < tol) {
        n++
        sk += ks[i]
        st += ts[i]
      }
    }
    if (n < 4) return null
    const mk = sk / n
    const mt = st / n
    let num = 0
    let den = 0
    for (let i = 0; i < ks.length; i++) {
      if (Math.abs(ts[i] - phase - ks[i] * period) < tol) {
        num += (ks[i] - mk) * (ts[i] - mt)
        den += (ks[i] - mk) ** 2
      }
    }
    if (den === 0) return null
    period = num / den
    phase = mt - period * mk
  }
  return { period, phase }
}

/**
 * ticks에 등간격 격자 t = phase + k·period 를 맞춘다(이상치 제외 최소제곱).
 * @returns null = 쓸 만한 박이 너무 적음
 */
export function fitGrid(ticks: ArrayLike<number>, bpm: number): { period: number; phase: number } | null {
  if (!(bpm > 0) || ticks.length < 4) return null
  const period = 60 / bpm
  const ts = Array.from(ticks)

  // 초기 위상: 각 박을 주기로 접은 값들의 원형 평균
  let sx = 0
  let sy = 0
  for (const v of ts) {
    const ang = (2 * Math.PI * v) / period
    sx += Math.cos(ang)
    sy += Math.sin(ang)
  }
  const phase = ((Math.atan2(sy, sx) / (2 * Math.PI)) * period + period) % period
  const ks = ts.map((v) => Math.round((v - phase) / period))
  // ticks는 hop(≈11.6ms) 단위라 ±6ms쯤 흔들린다. 마지막엔 3 hop 안쪽만 남긴다
  return robustLine(ks, ts, period, phase, [0.15 * period, 0.06 * period, 0.035, 0.035])
}

const ENV_HOP_SEC = 0.001
/** 에너지를 재는 창 — 저음(100Hz 안팎)의 한 주기보다 길어야 지속음이 출렁이지 않는다 */
const ENV_WIN_SEC = 0.01

/**
 * 1ms마다 "직전 10ms 에너지가 얼마나 확 늘었나"(log 차이, 양수만).
 * env[j]가 크면 어택이 ((j−1)·1ms, j·1ms] 안에 들어왔다는 뜻 — 창의 끝이 어택을 막 넘은 순간
 * 상대 증가가 가장 크다. 고역 강조(1차 차분)로 지속되는 저음보다 어택을 본다.
 */
export function onsetEnvelope(x: Float32Array, sr: number): Float32Array {
  const hop = sr * ENV_HOP_SEC
  const win = Math.max(1, Math.round(sr * ENV_WIN_SEC))
  // 누적합으로 아무 창의 에너지를 바로 구한다
  const cum = new Float64Array(x.length + 1)
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - (i > 0 ? x[i - 1] : 0)
    cum[i + 1] = cum[i] + d * d
  }
  const m = Math.floor(x.length / hop)
  // 무음 구간의 잡음이 log에서 부풀지 않도록 바닥값을 둔다
  const floor = (cum[x.length] / Math.max(1, x.length)) * win * 1e-3 + 1e-12
  const energy = (j: number) => {
    const end = Math.min(x.length, Math.round(j * hop))
    return cum[end] - cum[Math.max(0, end - win)]
  }
  const out = new Float32Array(m)
  let prev = Math.log(energy(0) + floor)
  for (let j = 1; j < m; j++) {
    const cur = Math.log(energy(j) + floor)
    out[j] = Math.max(0, cur - prev)
    prev = cur
  }
  return out
}

/** 예상 박 t 근처(±searchSec)에서 가장 센 어택의 시각. 칸의 가운데를 어택 시각으로 본다 */
function snapToOnset(env: Float32Array, t: number, searchSec: number): number {
  const lo = Math.max(1, Math.round((t - searchSec) / ENV_HOP_SEC))
  const hi = Math.min(env.length - 1, Math.round((t + searchSec) / ENV_HOP_SEC))
  let best = -1
  let bestV = 0
  for (let j = lo; j <= hi; j++) {
    if (env[j] > bestV) {
      bestV = env[j]
      best = j
    }
  }
  return best < 0 ? NaN : (best - 0.5) * ENV_HOP_SEC
}

/**
 * 격자의 박마다 가장 가까운 실제 어택(1ms 해상도)을 찾아, 그 점들로 BPM과 위상을 다시 맞춘다.
 * Essentia ticks는 hop 단위로 양자화되고 어택보다 10–20ms 이르게 나오는 경향이 있다.
 */
export function refineGrid(
  x: Float32Array,
  sr: number,
  grid: { period: number; phase: number },
  searchSec = 0.035,
): { period: number; phase: number } {
  const env = onsetEnvelope(x, sr)
  const dur = env.length * ENV_HOP_SEC
  let g = grid
  for (let pass = 0; pass < 2; pass++) {
    const ks: number[] = []
    const ts: number[] = []
    const k0 = Math.ceil((searchSec - g.phase) / g.period)
    for (let k = k0; ; k++) {
      const t = g.phase + k * g.period
      if (t > dur - searchSec) break
      const s = snapToOnset(env, t, searchSec)
      if (!Number.isNaN(s)) {
        ks.push(k)
        ts.push(s)
      }
    }
    const next = robustLine(ks, ts, g.period, g.phase, [searchSec, 0.015, 0.008])
    if (!next) break
    g = next
  }
  return g
}

/**
 * @param x 분석할 모노 신호
 * @param sr x의 샘플레이트
 * @param rhythm Essentia RhythmExtractor2013 래퍼(44.1kHz 입력)
 * @param fromSec 이 시각(x 기준) 이후의 첫 박을 anchor(1박)로 삼는다
 */
export function estimateGrid(x: Float32Array, sr: number, rhythm: RhythmFn, fromSec = 0): DetectedGrid | null {
  const r = rhythm(resampleLinear(x, sr, ESSENTIA_SR))
  const fit = fitGrid(r.ticks, r.bpm)
  if (!fit) return null
  const { period, phase } = refineGrid(x, sr, fit)
  const k = Math.ceil((fromSec - phase) / period - 1e-6)
  return {
    bpm: Math.round((60 / period) * 1000) / 1000,
    anchorSec: phase + k * period,
    confidence: r.confidence,
  }
}

/**
 * 분석 범위 — 고른 구간이 짧으면 MIN_ANALYSIS_SEC가 되도록 앞뒤로 넓힌다(곡 길이 안에서).
 */
export function analysisRange(durationSec: number, startSec: number, endSec: number): { from: number; to: number } {
  let from = Math.max(0, startSec)
  let to = Math.min(durationSec, endSec)
  const lack = MIN_ANALYSIS_SEC - (to - from)
  if (lack > 0) {
    from = Math.max(0, from - lack / 2)
    to = Math.min(durationSec, from + MIN_ANALYSIS_SEC)
    from = Math.max(0, to - MIN_ANALYSIS_SEC)
  }
  return { from, to }
}
