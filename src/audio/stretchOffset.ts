import { SimpleFilter, SoundTouch } from 'soundtouchjs'

/**
 * SoundTouch를 지난 소리가 "원본의 어느 프레임"인지 재는 보정값.
 *
 * 속도 tempo로 늘이고 줄인 출력의 n번째 샘플에서 들리는 원본 위치는 평균적으로
 *     입력 position = 시작 position + tempo·n + offset
 * 을 따른다. offset은 SoundTouch 내부 버퍼링 때문에 생기는 고정 어긋남(입력 프레임 단위)으로,
 * 속도·키에 따라 -4000 ~ +200프레임쯤 달라진다. 메트로놈 클릭을 음악에 맞추려면 이 값이 필요하다.
 *
 * 재는 법: 오른쪽 채널에 "자기 프레임 번호"(램프)를 넣고 같은 설정의 SoundTouch를 통과시키면,
 * 출력 오른쪽 값이 곧 그 순간 들리는 원본 프레임이다. 이를 직선으로 맞춘 절편이 offset.
 * 왼쪽에는 음악 비슷한 신호를 넣는다 — SoundTouch가 이어 붙일 자리를 고를 때 소리를 보기 때문.
 *
 * 비용: 몇 초 분량을 오프라인으로 한 번 돌린다(수십 ms). 속도·키가 바뀔 때만 다시 재고 캐시한다.
 */

const MEASURE_SEC = 4
/** 앞쪽은 시작 과도구간이라 맞춤에서 뺀다 */
const SKIP_SEC = 1

const cache = new Map<string, number>()

export function measureStretchOffset(tempo: number, pitchSemitones: number, sampleRate: number): number {
  const key = `${tempo.toFixed(4)}|${pitchSemitones}|${sampleRate}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  // 출력 MEASURE_SEC초를 얻을 만큼 입력을 만든다
  const n = Math.ceil(sampleRate * (MEASURE_SEC * tempo + 1))
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  let seed = 1
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  const beat = Math.round(sampleRate * 0.5)
  for (let i = 0; i < n; i++) {
    const b = i % beat
    left[i] =
      0.25 * Math.sin((i * 2 * Math.PI * 196) / sampleRate) +
      0.15 * Math.sin((i * 2 * Math.PI * 311) / sampleRate) +
      (b < 1500 ? 0.5 * Math.exp(-b / 250) * rnd() : 0) +
      0.02 * rnd()
    right[i] = i / n
  }
  const source = {
    extract(target: Float32Array, numFrames: number, position: number) {
      let i = 0
      for (; i < numFrames && position + i < n; i++) {
        target[i * 2] = left[position + i]
        target[i * 2 + 1] = right[position + i]
      }
      return i
    },
  }

  const st = new SoundTouch()
  st.tempo = tempo
  st.pitchSemitones = pitchSemitones
  const filter = new SimpleFilter(source, st, () => {})

  const outLen = Math.floor(sampleRate * MEASURE_SEC)
  const pos = new Float32Array(outLen)
  const buf = new Float32Array(4096 * 2)
  let got = 0
  while (got < outLen) {
    const k = filter.extract(buf, Math.min(4096, outLen - got))
    if (k === 0) break
    for (let i = 0; i < k; i++) pos[got + i] = buf[i * 2 + 1] * n
    got += k
  }

  // 기울기는 tempo로 고정하고 절편만 맞춘다: offset = 중앙값(pos[i] − tempo·i).
  // 중앙값이라 SoundTouch가 구간을 반복·건너뛰며 생기는 앞뒤 흔들림에 끌려가지 않는다.
  const start = Math.floor(sampleRate * SKIP_SEC)
  const diffs: number[] = []
  for (let i = start; i < got; i += 11) diffs.push(pos[i] - tempo * i)
  diffs.sort((a, b) => a - b)
  const offset = diffs.length ? diffs[diffs.length >> 1] : 0

  cache.set(key, offset)
  return offset
}
