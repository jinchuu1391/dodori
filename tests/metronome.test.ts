/**
 * 메트로놈 검증.
 * 1) ClickMixer 단독: 박 경계에서 정확히 한 번씩, 강박 패턴, 되감기(구간 반복) 처리
 * 2) 실제 파이프라인: LoopingBufferSource → SoundTouch(soundtouchjs)를 오프라인으로 돌리고
 *    엔진과 같은 식(시작 position + tempo·n + 보정값)으로 클릭을 찍은 뒤, 오른쪽 채널에 넣은
 *    프레임 번호 램프로 "그 순간 실제로 들리던 원본 위치"를 읽어 박과의 어긋남을 잰다.
 */
import assert from 'node:assert/strict'
import { SimpleFilter, SoundTouch } from 'soundtouchjs'
import { ClickMixer } from '../src/audio/metronome.ts'
import { LoopingBufferSource } from '../src/audio/loopSource.ts'
import { measureStretchOffset } from '../src/audio/stretchOffset.ts'

const SR = 44100

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

/** 믹서를 무음 버퍼에 돌려 클릭이 시작된 출력 샘플 번호들을 얻는다 */
function onsets(mixer: ClickMixer, frames: Float64Array, block = 4096): number[] {
  const n = frames.length
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  for (let s = 0; s < n; s += block) {
    const k = Math.min(block, n - s)
    mixer.mix(L.subarray(s, s + k), R.subarray(s, s + k), frames.subarray(s, s + k), k)
  }
  // 클릭은 0에서 시작해 1ms 동안 올라간다 — 무음 뒤 첫 비영 샘플의 한 칸 앞이 시작점
  const out: number[] = []
  let quiet = 1e9
  for (let i = 0; i < n; i++) {
    if (L[i] !== 0) {
      if (quiet > SR * 0.01) out.push(i - 1)
      quiet = 0
    } else quiet++
  }
  return out
}

test('일정 속도: 박마다 정확한 샘플에서 한 번씩 친다', () => {
  const m = new ClickMixer(SR, SR)
  m.grid = { bpm: 120, anchorSec: 0.25, beatsPerBar: 4 }
  const frames = new Float64Array(SR * 3).map((_, i) => i)
  const got = onsets(m, frames)
  // 0.25, 0.75, 1.25, ... 2.75초
  const want = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75].map((t) => Math.round(t * SR))
  assert.equal(got.length, want.length, `클릭 ${got.length}개`)
  got.forEach((g, i) => assert.ok(Math.abs(g - want[i]) <= 1, `${i}번째 ${g} vs ${want[i]}`))
})

test('한 마디 박 수에 맞춰 1박만 강박', () => {
  const m = new ClickMixer(SR, SR)
  m.grid = { bpm: 240, anchorSec: 0, beatsPerBar: 3 }
  const accents: boolean[] = []
  const frames = new Float64Array(1)
  const L = new Float32Array(1)
  const R = new Float32Array(1)
  for (let i = 0; i < SR * 2; i++) {
    frames[0] = i
    const before = m.clickCount
    m.mix(L, R, frames, 1)
    if (m.clickCount > before) accents.push(m.lastAccent)
  }
  assert.deepEqual(accents.slice(0, 7), [true, false, false, true, false, false, true])
})

test('구간 반복으로 되감기면: B 직전 박까지 치고, A가 박 위가 아니면 다음 박에서 친다', () => {
  const m = new ClickMixer(SR, SR)
  m.grid = { bpm: 60, anchorSec: 0, beatsPerBar: 4 } // 매 1초
  // A=1.3초, B=3.6초 구간을 두 바퀴: 1.3→3.6, 1.3→3.6
  const A = 1.3 * SR
  const len = 2.3 * SR
  const frames = new Float64Array(Math.round(len * 2)).map((_, i) => A + (i % len))
  const got = onsets(m, frames).map((i) => frames[i] / SR)
  // 바퀴마다 2초, 3초 — A(1.3)에서는 치지 않는다
  assert.deepEqual(got.map((t) => Math.round(t * 100) / 100), [2, 3, 2, 3])
})

test('되감긴 자리가 박 위면 그 자리에서 친다', () => {
  const m = new ClickMixer(SR, SR)
  m.grid = { bpm: 60, anchorSec: 0.5, beatsPerBar: 4 }
  const A = 1.5 * SR // 박 위
  const len = 1.25 * SR
  const frames = new Float64Array(Math.round(len * 2)).map((_, i) => A + (i % len))
  const got = onsets(m, frames).map((i) => Math.round((frames[i] / SR) * 100) / 100)
  assert.deepEqual(got, [1.5, 2.5, 1.5, 2.5])
})

test('소리가 아직 없는 구간(NaN)에서는 치지 않는다', () => {
  const m = new ClickMixer(SR, SR)
  m.grid = { bpm: 120, anchorSec: 0, beatsPerBar: 4 }
  const frames = new Float64Array(SR).map((_, i) => (i < SR / 2 ? NaN : i))
  const got = onsets(m, frames)
  assert.deepEqual(got.map((i) => Math.round(i / SR * 10) / 10), [0.5])
})

/* ---------- 실제 파이프라인 ---------- */

/** 왼쪽 = 음악 비슷한 신호, 오른쪽 = 프레임 번호 램프 */
function rampBuffer(seconds: number) {
  const n = Math.round(seconds * SR)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  let seed = 11
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  const kick = Math.round(SR * 0.52)
  for (let i = 0; i < n; i++) {
    const b = i % kick
    left[i] = 0.3 * Math.sin((i * 2 * Math.PI * 220) / SR) + (b < 1800 ? 0.6 * Math.exp(-b / 280) * rnd() : 0) + 0.03 * rnd()
    right[i] = i / n
  }
  const buf = {
    length: n, numberOfChannels: 2, sampleRate: SR, duration: n / SR,
    getChannelData: (c: number) => (c === 0 ? left : right),
  } as unknown as AudioBuffer
  return { buf, n }
}

/**
 * 엔진과 같은 방식으로 돌리고, 클릭마다 (실제 들리던 원본 프레임 − 가장 가까운 박 프레임)을
 * 출력 시간(ms)으로 돌려준다.
 */
function pipeline(opts: { tempo: number; pitch: number; startSec: number; loop?: [number, number]; seconds: number }) {
  const { buf, n } = rampBuffer(40)
  const src = new LoopingBufferSource(buf)
  if (opts.loop) src.setLoop(true, Math.round(opts.loop[0] * SR), Math.round(opts.loop[1] * SR))
  const st = new SoundTouch()
  st.tempo = opts.tempo
  st.pitchSemitones = opts.pitch
  const filter = new SimpleFilter(src, st, () => {})
  const p0 = Math.round(opts.startSec * SR)
  filter.sourcePosition = p0
  src.seek(p0)

  const grid = { bpm: 115.385, anchorSec: 0.52 * 0.25, beatsPerBar: 4 } // 0.52초 간격 = 115.385 BPM
  const interval = (60 / grid.bpm) * SR
  const mixer = new ClickMixer(SR, SR)
  mixer.grid = grid
  const offset = measureStretchOffset(opts.tempo, opts.pitch, SR)

  const total = Math.round(opts.seconds * SR)
  const heard = new Float64Array(total) // 램프로 읽은 실제 위치
  const model = new Float64Array(total) // 엔진 식
  const tmp = new Float32Array(4096 * 2)
  let out = 0
  while (out < total) {
    const k = filter.extract(tmp, Math.min(4096, total - out))
    if (!k) break
    for (let i = 0; i < k; i++) {
      heard[out + i] = tmp[i * 2 + 1] * n
      const fp = p0 + opts.tempo * (out + i) + offset
      model[out + i] = fp < p0 ? NaN : src.frameAtPosition(fp)
    }
    out += k
  }
  const hits = onsets(mixer, model.subarray(0, out))
  const errs = hits
    .filter((i) => i > SR * 0.3) // 시작 직후 과도구간 제외
    .map((i) => {
      const f = heard[i]
      const k = Math.round((f - grid.anchorSec * SR) / interval)
      return ((f - (grid.anchorSec * SR + k * interval)) / opts.tempo / SR) * 1000
    })
  const abs = errs.map(Math.abs).sort((a, b) => a - b)
  return { count: hits.length, p90: abs[Math.floor(abs.length * 0.9)], max: abs[abs.length - 1], errs }
}

// 속도별 기대 정확도. SoundTouch가 느린 속도에서 음악 자체를 앞뒤로 미는 만큼(측정값)을 상한으로 둔다
const CASES = [
  { tempo: 1, pitch: 0, p90: 12 },
  { tempo: 1.25, pitch: 0, p90: 15 },
  { tempo: 0.75, pitch: 0, p90: 25 },
  { tempo: 0.5, pitch: 0, p90: 60 },
  { tempo: 1, pitch: 5, p90: 25 },
]
for (const c of CASES) {
  test(`실제 SoundTouch 통과 후 클릭이 박에 붙는다 — ${c.tempo}× 키 ${c.pitch}`, () => {
    const r = pipeline({ tempo: c.tempo, pitch: c.pitch, startSec: 3.1, seconds: 12 })
    const expected = Math.floor((12 * c.tempo) / 0.52)
    assert.ok(Math.abs(r.count - expected) <= 2, `클릭 ${r.count}개, 기대 ≈${expected}`)
    console.log(`      어긋남 p90 ${r.p90.toFixed(1)}ms · 최대 ${r.max.toFixed(1)}ms (클릭 ${r.count}개)`)
    assert.ok(r.p90 < c.p90, `p90 ${r.p90.toFixed(1)}ms ≥ ${c.p90}ms`)
  })
}

test('구간 반복 중에도(A는 박이 아닌 임의 지점) 클릭이 박에 붙는다', () => {
  const r = pipeline({ tempo: 1, pitch: 0, startSec: 5.07, loop: [5.07, 8.33], seconds: 15 })
  console.log(`      어긋남 p90 ${r.p90.toFixed(1)}ms · 최대 ${r.max.toFixed(1)}ms (클릭 ${r.count}개)`)
  assert.ok(r.p90 < 12, `p90 ${r.p90.toFixed(1)}ms`)
  // 바퀴(3.26초)마다 박 6개 남짓 → 15초에 28개 안팎
  assert.ok(r.count >= 26 && r.count <= 30, `클릭 ${r.count}개`)
})

console.log(`\n${passed} passed`)
