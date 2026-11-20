/**
 * 자동 박 감지 검증 — 실제 Essentia(WASM, UMD 빌드)로 합성 음원을 분석해
 * BPM · 첫 박 위치가 정답과 얼마나 맞는지 잰다.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  type RhythmFn,
  analysisRange,
  estimateGrid,
  fitGrid,
  MIN_ANALYSIS_SEC,
} from '../src/audio/beatDetect.ts'

const require = createRequire(import.meta.url)
const { Essentia, EssentiaWASM } = require('essentia.js')
const essentia = new Essentia(EssentiaWASM)

const rhythm: RhythmFn = (x) => {
  const v = essentia.arrayToVector(x)
  const r = essentia.RhythmExtractor2013(v, 208, 'multifeature', 40)
  const out = { bpm: r.bpm, ticks: essentia.vectorToArray(r.ticks), confidence: r.confidence }
  v.delete?.()
  return out
}

let passed = 0
let failed = 0
/** Essentia(emscripten)가 uncaughtException을 가로채 압축 소스를 통째로 찍으므로 여기서 받는다 */
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (e) {
    failed++
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`)
  }
}

/** 결정적 잡음 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

/** 박마다 클릭(4박마다 높은 음) */
function clickTrack(sr: number, bpm: number, offset: number, dur: number): Float32Array {
  const x = new Float32Array(Math.round(sr * dur))
  const noise = rng(1)
  for (let i = 0; i < x.length; i++) x[i] = noise() * 0.01
  for (let k = 0; ; k++) {
    const t = offset + (k * 60) / bpm
    if (t > dur - 0.1) break
    const s = Math.round(t * sr)
    const f = k % 4 ? 800 : 1500
    for (let i = 0; i < sr * 0.05 && s + i < x.length; i++) {
      x[s + i] += Math.exp(-i / (sr * 0.007)) * Math.sin((2 * Math.PI * f * i) / sr)
    }
  }
  return x
}

/** 킥(정박) + 하이햇(엇박) + 지속음 — 좀 더 음악 같은 신호 */
function drumTrack(sr: number, bpm: number, offset: number, dur: number): Float32Array {
  const x = new Float32Array(Math.round(sr * dur))
  const noise = rng(7)
  for (let i = 0; i < x.length; i++) x[i] = 0.15 * Math.sin((2 * Math.PI * 220 * i) / sr) + noise() * 0.005
  const P = 60 / bpm
  for (let k = 0; ; k++) {
    const t = offset + k * P
    if (t > dur - 0.3) break
    const s = Math.round(t * sr)
    let ph = 0
    for (let i = 0; i < sr * 0.15; i++) {
      const f = 50 + 100 * Math.exp(-i / (sr * 0.02))
      ph += (2 * Math.PI * f) / sr
      x[s + i] += 0.9 * Math.exp(-i / (sr * 0.05)) * Math.sin(ph)
    }
    const h = Math.round((t + P / 2) * sr)
    for (let i = 0; i < sr * 0.03 && h + i < x.length; i++) x[h + i] += 0.25 * Math.exp(-i / (sr * 0.004)) * noise() * 2
  }
  return x
}

/** anchor가 정답 격자의 어떤 박에서 몇 ms 떨어져 있나 */
function phaseErrMs(anchor: number, bpm: number, offset: number): number {
  const P = 60 / bpm
  const k = Math.round((anchor - offset) / P)
  return (anchor - offset - k * P) * 1000
}

test('fitGrid: 흔들리는 수렴 구간 · 양자화 · 이상치가 있어도 직선을 찾는다', () => {
  const P = 60 / 113
  const ticks: number[] = [0.2, 0.55] // 수렴 전 엉뚱한 박
  const r = rng(3)
  for (let k = 2; k < 60; k++) ticks.push(1.234 + k * P + r() * 0.02)
  ticks.splice(30, 0, 1.234 + 30.5 * P) // 엇박 하나
  const fit = fitGrid(ticks, 112)
  assert.ok(fit)
  assert.ok(Math.abs(60 / fit.period - 113) < 0.05, `bpm ${60 / fit.period}`)
  assert.ok(Math.abs(phaseErrMs(fit.phase, 113, 1.234)) < 5, `phase ${phaseErrMs(fit.phase, 113, 1.234)}ms`)
})

test('fitGrid: 박이 너무 적으면 null', () => {
  assert.equal(fitGrid([0.5, 1, 1.5], 120), null)
  assert.equal(fitGrid([0.5, 1, 1.5, 2], 0), null)
})

test('analysisRange: 짧은 구간은 앞뒤로 넓히고, 곡 길이를 넘지 않는다', () => {
  assert.deepEqual(analysisRange(200, 50, 100), { from: 50, to: 100 })
  const mid = analysisRange(200, 50, 54)
  assert.ok(Math.abs(mid.to - mid.from - MIN_ANALYSIS_SEC) < 1e-9 && mid.from < 50 && mid.to > 54)
  assert.deepEqual(analysisRange(200, 1, 3), { from: 0, to: MIN_ANALYSIS_SEC })
  assert.deepEqual(analysisRange(200, 197, 199), { from: 200 - MIN_ANALYSIS_SEC, to: 200 })
  assert.deepEqual(analysisRange(8, 2, 4), { from: 0, to: 8 })
})

const cases = [
  { name: '클릭 97 BPM, 48kHz(리샘플 경로)', sr: 48000, bpm: 97, offset: 0.37, dur: 20, make: clickTrack },
  { name: '클릭 140 BPM, 44.1kHz', sr: 44100, bpm: 140, offset: 0.05, dur: 16, make: clickTrack },
  { name: '드럼(킥+엇박 하이햇) 128 BPM', sr: 44100, bpm: 128, offset: 0.61, dur: 24, make: drumTrack },
  { name: '드럼 84 BPM, 48kHz', sr: 48000, bpm: 84, offset: 1.1, dur: 24, make: drumTrack },
]

for (const c of cases) {
  test(`estimateGrid: ${c.name} — BPM ±0.1, 첫 박 ±3ms`, () => {
    const x = c.make(c.sr, c.bpm, c.offset, c.dur)
    const g = estimateGrid(x, c.sr, rhythm, 3)
    assert.ok(g, 'no grid')
    const err = phaseErrMs(g.anchorSec, c.bpm, c.offset)
    console.log(`        bpm ${g.bpm}  anchor ${g.anchorSec.toFixed(4)}s  err ${err.toFixed(1)}ms  conf ${g.confidence.toFixed(2)}`)
    assert.ok(Math.abs(g.bpm - c.bpm) < 0.1, `bpm ${g.bpm}`)
    assert.ok(Math.abs(err) < 3, `phase err ${err}ms`)
    // fromSec(3s) 이후 첫 박
    assert.ok(g.anchorSec >= 3 - 1e-6 && g.anchorSec < 3 + 60 / g.bpm, `anchor ${g.anchorSec}`)
    // 곡 끝까지 누적 어긋남
    const last = g.anchorSec + Math.floor((c.dur - 1 - g.anchorSec) / (60 / g.bpm)) * (60 / g.bpm)
    const drift = phaseErrMs(last, c.bpm, c.offset)
    assert.ok(Math.abs(drift) < 5, `drift at end ${drift}ms`)
  })
}

console.log(`beatDetect: ${passed} passed${failed ? `, ${failed} failed` : ''}`)
if (failed) process.exit(1)
