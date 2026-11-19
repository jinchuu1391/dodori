/**
 * 파형 렌더용 다단 해상도 데이터.
 *
 * 곡을 열 때 LEVEL_BLOCK 프레임(약 6ms)마다 peak(절대 최대)와 제곱합을 한 번 훑어 메모리에
 * 둔다. 4분 스테레오 = 약 2천만 샘플 → 수십 ms, 결과는 4만여 칸 × 2 ≈ 0.5MB.
 * 화면 픽셀 한 열은 보이는 범위에 따라
 *   - 블록 여러 개를 모으거나(축소 상태)
 *   - 블록보다 좁아지면 원본 샘플을 직접 읽는다(깊이 확대한 상태 — 그래도 화면 폭 × 512 프레임 이하)
 * 그래서 어느 배율에서든 픽셀당 실제 데이터로 그려지고 계단이 생기지 않는다.
 *
 * 값은 두 가지:
 * - peak: 순간 최대치. 크게 마스터링된 곡은 거의 전 구간이 1에 붙는다(옅게 그린다).
 * - rms : 체감 음량. 조용한 절·센 후렴이 여기서 구분된다(진하게 그린다).
 */

export const LEVEL_BLOCK = 256

export interface WaveLevels {
  frames: number
  sampleRate: number
  channels: Float32Array[]
  /** 블록별 채널 통틀어 절대 최대값(원값) */
  peak: Float32Array
  /** 블록별 채널 통틀어 제곱합(원값) */
  sumSq: Float64Array
  /** 정규화 기준 — 곡 전체 peak 최대, 곡을 1600칸으로 나눴을 때 rms 최대 */
  pMax: number
  rMax: number
}

export function buildWaveLevels(buffer: AudioBuffer): WaveLevels {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))

  const frames = buffer.length
  const nBlocks = Math.ceil(frames / LEVEL_BLOCK)
  const peak = new Float32Array(nBlocks)
  const sumSq = new Float64Array(nBlocks)

  for (let b = 0; b < nBlocks; b++) {
    const start = b * LEVEL_BLOCK
    const end = Math.min(frames, start + LEVEL_BLOCK)
    let p = 0
    let sq = 0
    for (const data of channels) {
      for (let i = start; i < end; i++) {
        const s = data[i]
        const v = s < 0 ? -s : s
        if (v > p) p = v
        sq += s * s
      }
    }
    peak[b] = p
    sumSq[b] = sq
  }

  let pMax = 0
  for (let b = 0; b < nBlocks; b++) if (peak[b] > pMax) pMax = peak[b]

  // rms 기준은 곡 전체를 볼 때의 해상도(1600칸)로 잡는다. 확대하면 짧은 창의 rms가 이보다
  // 커질 수 있는데, 그건 렌더 때 peak로 눌러 둔다.
  let rMax = 0
  const coarse = Math.max(1, Math.round(nBlocks / 1600))
  for (let b = 0; b < nBlocks; b += coarse) {
    const e = Math.min(nBlocks, b + coarse)
    let sq = 0
    for (let j = b; j < e; j++) sq += sumSq[j]
    const n = (Math.min(frames, e * LEVEL_BLOCK) - b * LEVEL_BLOCK) * channels.length
    const r = n > 0 ? Math.sqrt(sq / n) : 0
    if (r > rMax) rMax = r
  }

  return { frames, sampleRate: buffer.sampleRate, channels, peak, sumSq, pMax, rMax }
}

/**
 * 프레임 구간 [f0, f1)의 표시용 peak·rms(0~1).
 *
 * rms는 가장 센 부분이 0.8에 오게 정규화하고, 1.5제곱으로 펴서 크게 마스터링된 곡의
 * 몇 dB 차이도 눈에 띄게 한다(후렴 1.0 대 절 0.7 → 1.0 대 0.59). 같은 열의 peak는 넘지 않는다.
 */
export function levelAt(L: WaveLevels, f0: number, f1: number): { peak: number; rms: number } {
  f0 = Math.max(0, Math.floor(f0))
  f1 = Math.min(L.frames, Math.ceil(f1))
  if (f1 <= f0) f1 = Math.min(L.frames, f0 + 1)
  if (f1 <= f0) return { peak: 0, rms: 0 }

  let p = 0
  let sq = 0
  let n = 0
  if (f1 - f0 >= LEVEL_BLOCK * 2) {
    const b0 = Math.floor(f0 / LEVEL_BLOCK)
    const b1 = Math.min(L.peak.length, Math.ceil(f1 / LEVEL_BLOCK))
    for (let b = b0; b < b1; b++) {
      if (L.peak[b] > p) p = L.peak[b]
      sq += L.sumSq[b]
    }
    n = (Math.min(L.frames, b1 * LEVEL_BLOCK) - b0 * LEVEL_BLOCK) * L.channels.length
  } else {
    for (const data of L.channels) {
      for (let i = f0; i < f1; i++) {
        const s = data[i]
        const v = s < 0 ? -s : s
        if (v > p) p = v
        sq += s * s
      }
    }
    n = (f1 - f0) * L.channels.length
  }

  const peak = L.pMax > 0 ? Math.min(1, p / L.pMax) : 0
  const r = n > 0 && L.rMax > 0 ? Math.sqrt(sq / n) / L.rMax : 0
  return { peak, rms: Math.min(peak, Math.pow(r, 1.5) * 0.8) }
}

/**
 * 화면 열(1px)마다의 peak·rms. 열 i는 [startSec, startSec + span)을 width칸으로 나눈 i번째.
 *
 * 열 경계는 화면 시작점이 아니라 곡의 절대 시간 격자(col × 픽셀당 프레임)에 맞춘다.
 * 화면 시작점 기준으로 자르면 좌우 이동 때마다 경계가 픽셀 일부만큼 어긋나 같은 소리가
 * 매번 다른 샘플 묶음으로 계산되고, 막대 높이가 프레임마다 흔들려 자글거린다.
 * 격자에 맞추면 이동해도 각 열은 같은 값을 유지한 채 통째로 옮겨 간다(어긋남은 1px 미만).
 */
export function columnLevels(
  L: WaveLevels,
  startSec: number,
  span: number,
  width: number,
): { peak: Float32Array; rms: Float32Array } {
  const peak = new Float32Array(width)
  const rms = new Float32Array(width)
  if (span <= 0 || width <= 0) return { peak, rms }
  const framesPerPx = (span / width) * L.sampleRate
  // 부동소수 오차로 정수 경계 바로 아래에 떨어지는 경우를 격자 쪽으로 붙인다
  const firstCol = Math.floor((startSec * L.sampleRate) / framesPerPx + 1e-6)
  for (let x = 0; x < width; x++) {
    const a = (firstCol + x) * framesPerPx
    const lv = levelAt(L, a, a + framesPerPx)
    peak[x] = lv.peak
    rms[x] = lv.rms
  }
  return { peak, rms }
}
