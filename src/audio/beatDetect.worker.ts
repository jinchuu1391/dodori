/// <reference lib="webworker" />
/**
 * 자동 박 감지 워커. Essentia(WASM ~2MB)는 여기서만 불러온다 — 버튼을 누를 때만 내려받고,
 * WASM 동기 컴파일과 수 초짜리 분석이 메인 스레드(오디오 콜백)를 막지 않도록.
 */
import { EssentiaWASM } from 'essentia.js/dist/essentia-wasm.es.js'
import Essentia from 'essentia.js/dist/essentia.js-core.es.js'
import { type DetectedGrid, type RhythmFn, estimateGrid } from './beatDetect'

export interface BeatDetectRequest {
  samples: Float32Array
  sampleRate: number
  /** samples 기준, 이 시각 이후 첫 박을 1박으로 */
  fromSec: number
}

export type BeatDetectResponse = { ok: true; grid: DetectedGrid | null } | { ok: false; error: string }

let essentia: Essentia | null = null

const rhythm: RhythmFn = (x) => {
  essentia ??= new Essentia(EssentiaWASM)
  const e = essentia
  const signal = e.arrayToVector(x)
  try {
    const r = e.RhythmExtractor2013(signal, 208, 'multifeature', 40)
    const ticks = r.ticks.size() > 0 ? e.vectorToArray(r.ticks) : new Float32Array(0)
    r.ticks.delete()
    r.estimates.delete()
    r.bpmIntervals.delete()
    return { bpm: r.bpm, ticks, confidence: r.confidence }
  } finally {
    signal.delete()
  }
}

self.onmessage = (ev: MessageEvent<BeatDetectRequest>) => {
  const { samples, sampleRate, fromSec } = ev.data
  let res: BeatDetectResponse
  try {
    res = { ok: true, grid: estimateGrid(samples, sampleRate, rhythm, fromSec) }
  } catch (err) {
    res = { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(res)
}
