import { analysisRange, toMono } from './beatDetect'
import type { BeatDetectRequest, BeatDetectResponse } from './beatDetect.worker'

export interface AutoGrid {
  bpm: number
  /** 곡 기준 [s] */
  anchorSec: number
  confidence: number
}

/**
 * 곡의 [startSec, endSec]를 워커에서 분석해 BPM과 첫 박(startSec 이후 첫 박)을 찾는다.
 * 구간이 짧으면 박 추적이 수렴하도록 앞뒤로 넓혀 분석한다.
 * @returns null = 박을 찾지 못함
 */
export function detectBeatGrid(buffer: AudioBuffer, startSec: number, endSec: number): Promise<AutoGrid | null> {
  const { from, to } = analysisRange(buffer.duration, startSec, endSec)
  const sr = buffer.sampleRate
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const samples = toMono(channels, Math.floor(from * sr), Math.min(buffer.length, Math.ceil(to * sr)))

  const worker = new Worker(new URL('./beatDetect.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<AutoGrid | null>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<BeatDetectResponse>) => {
      const r = e.data
      if (!r.ok) reject(new Error(r.error))
      else resolve(r.grid && { ...r.grid, anchorSec: r.grid.anchorSec + from })
    }
    worker.onerror = (e) => reject(new Error(e.message || '박 분석 워커를 불러오지 못했습니다.'))
    const req: BeatDetectRequest = { samples, sampleRate: sr, fromSec: Math.max(0, startSec - from) }
    worker.postMessage(req, [samples.buffer])
  }).finally(() => worker.terminate())
}
