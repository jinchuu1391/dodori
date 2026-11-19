/**
 * 파형 렌더용 피크 계산. 버킷별 절대 최대값(0~1).
 *
 * 4분 스테레오 = 약 2천만 샘플 한 번 훑기 → 수십 ms. 메인 스레드에서 감당되는 수준이고,
 * 결과는 Song.peaks에 캐시해서 같은 곡을 다시 열 때는 아예 돌지 않는다.
 * (곡이 훨씬 길어지면 이 함수만 Web Worker로 옮기면 된다)
 */
export function computePeaks(buffer: AudioBuffer, buckets = 1600): number[] {
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))

  const len = buffer.length
  const out = new Array<number>(buckets).fill(0)
  if (len === 0) return out

  const step = len / buckets

  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * step)
    const end = Math.min(len, Math.floor((b + 1) * step))
    let peak = 0
    for (let c = 0; c < channels.length; c++) {
      const data = channels[c]
      for (let i = start; i < end; i++) {
        const v = data[i] < 0 ? -data[i] : data[i]
        if (v > peak) peak = v
      }
    }
    out[b] = peak
  }

  // 조용한 곡도 파형이 보이도록 최대값 기준으로 정규화
  const max = out.reduce((m, v) => (v > m ? v : m), 0)
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] = out[i] / max
  return out
}
