/**
 * 파형 열 계산 검증. 타악기처럼 순간적으로 튀는 신호에서 좌우 이동 때 막대가
 * 흔들리지 않는지(= 정수 px만큼 옮기면 열 값이 그대로 옆으로 가는지) 본다.
 */
import assert from 'node:assert/strict'
import { buildWaveLevels, columnLevels, levelAt } from '../src/audio/peaks.ts'

const SR = 44100

/** 잡음 바탕 + 불규칙한 간격의 타격음. 시드 고정이라 매번 같다 */
function drumLike(seconds: number): AudioBuffer {
  const frames = Math.round(seconds * SR)
  let seed = 12345
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const data = [new Float32Array(frames), new Float32Array(frames)]
  for (let i = 0; i < frames; i++) data[0][i] = data[1][i] = (rand() * 2 - 1) * 0.05
  for (let t = 0; t < frames; t += 2000 + Math.floor(rand() * 9000)) {
    const amp = 0.3 + rand() * 0.7
    for (let k = 0; k < 1500 && t + k < frames; k++) {
      const v = amp * Math.exp(-k / 200) * (rand() * 2 - 1)
      data[0][t + k] += v
      data[1][t + k] += v * 0.8
    }
  }
  return {
    length: frames,
    numberOfChannels: 2,
    sampleRate: SR,
    duration: frames / SR,
    getChannelData: (c: number) => data[c],
  } as unknown as AudioBuffer
}

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

const L = buildWaveLevels(drumLike(30))
const WIDTH = 1200

/**
 * 화면을 px만큼(소수 포함) 옮긴 앞뒤 두 장면을 비교한다. 실제 스크롤은 0.37px처럼 픽셀 일부씩
 * 움직이므로, 그려진 열이 floor(px) 또는 ceil(px)칸 옆으로 통째로 옮겨 갔으면 흔들림이 없는
 * 것이다. 두 정렬 중 나은 쪽의 최대 차(0~1, 파형 높이 비율)를 돌려준다.
 */
function shiftDiff(
  cols: (start: number) => { peak: Float32Array; rms: Float32Array },
  start: number,
  span: number,
  px: number,
): number {
  const a = cols(start)
  const b = cols(start + (px * span) / WIDTH)
  let best = Infinity
  for (const off of new Set([Math.floor(px), Math.ceil(px)])) {
    let worst = 0
    for (let x = 0; x + off < WIDTH; x++) {
      worst = Math.max(worst, Math.abs(b.peak[x] - a.peak[x + off]), Math.abs(b.rms[x] - a.rms[x + off]))
    }
    best = Math.min(best, worst)
  }
  return best
}

/** 수정 전 방식 — 열 경계를 화면 시작점에서 잡는다(대조군) */
function oldColumns(start: number, span: number) {
  const peak = new Float32Array(WIDTH)
  const rms = new Float32Array(WIDTH)
  const fpp = (span / WIDTH) * SR
  for (let x = 0; x < WIDTH; x++) {
    const a = start * SR + x * fpp
    const lv = levelAt(L, a, a + fpp)
    peak[x] = lv.peak
    rms[x] = lv.rms
  }
  return { peak, rms }
}

// 블록을 모으는 배율(픽셀당 수천 프레임)과 원본 샘플을 읽는 배율(픽셀당 수백 프레임) 둘 다
const CASES = [
  { name: '곡 30초 중 12초를 보는 배율(블록 모음)', span: 12.3456 },
  { name: '곡 30초 중 3초를 보는 배율(블록 모음)', span: 3.0789 },
  { name: '곡 30초 중 0.4초를 보는 배율(원본 샘플)', span: 0.4123 },
]
// 격자에 딱 맞지 않는 시작점들
const STARTS = [1.2345678, 4.0000123, 7.7777, 10.1010101]
// 한 번의 스크롤 이벤트로 움직이는 양 — 픽셀 일부부터 수십 px까지
const PANS = [0.37, 0.5, 1, 2.71, 7, 40.25]

for (const c of CASES) {
  test(`픽셀 일부씩 좌우 이동해도 열 값이 통째로 옮겨 간다 — ${c.name}`, () => {
    for (const s of STARTS) {
      for (const px of PANS) {
        const d = shiftDiff((st) => columnLevels(L, st, c.span, WIDTH), s, c.span, px)
        assert.ok(d < 1e-6, `start=${s} px=${px} 최대 차 ${d}`)
      }
    }
  })
}

test('대조군: 예전 방식은 같은 이동에서 막대가 눈에 띄게 흔들린다', () => {
  let worst = 0
  for (const c of CASES)
    for (const s of STARTS) for (const px of PANS) worst = Math.max(worst, shiftDiff((st) => oldColumns(st, c.span), s, c.span, px))
  // 높이의 5% 이상 = 200px 파형에서 10px 이상 튀는 열이 있다
  assert.ok(worst > 0.05, `예전 방식 최대 차 ${worst}`)
  console.log(`      (예전 방식 최대 흔들림: 높이의 ${(worst * 100).toFixed(0)}%)`)
})

test('열 값은 0~1, rms는 같은 열의 peak를 넘지 않는다', () => {
  const { peak, rms } = columnLevels(L, 2.5, 9.9, WIDTH)
  for (let x = 0; x < WIDTH; x++) {
    assert.ok(peak[x] >= 0 && peak[x] <= 1)
    assert.ok(rms[x] >= 0 && rms[x] <= peak[x] + 1e-7)
  }
})

console.log(`\n${passed} passed`)
