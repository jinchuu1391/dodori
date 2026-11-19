/**
 * LoopingBufferSource 검증. 채널 데이터를 data[i] = i 로 채워서
 * "어느 원본 프레임을 읽었는지"를 출력값으로 그대로 확인한다.
 */
import assert from 'node:assert/strict'
import { LoopingBufferSource, MIN_LOOP_FRAMES } from '../src/audio/loopSource.ts'

function fakeBuffer(frames: number, channels = 2): AudioBuffer {
  const data: Float32Array[] = []
  for (let c = 0; c < channels; c++) {
    const arr = new Float32Array(frames)
    for (let i = 0; i < frames; i++) arr[i] = i
    data.push(arr)
  }
  return {
    length: frames,
    numberOfChannels: channels,
    sampleRate: 48000,
    duration: frames / 48000,
    getChannelData: (c: number) => data[c],
  } as unknown as AudioBuffer
}

/** 좌채널만 뽑아서 "읽은 원본 프레임 순서"로 본다 */
function leftOf(target: Float32Array, frames: number): number[] {
  const out: number[] = []
  for (let i = 0; i < frames; i++) out.push(target[i * 2])
  return out
}

let passed = 0
function test(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

const TOTAL = 10000
const START = 1000
const LEN = MIN_LOOP_FRAMES * 2 // 2048 — 최소 루프 길이보다 길게
const END = START + LEN

test('루프 꺼짐: 순서대로 읽고, 파일 끝에서 부족분을 반환', () => {
  const src = new LoopingBufferSource(fakeBuffer(TOTAL))
  const target = new Float32Array(8 * 2)
  const n = src.extract(target, 8, 100)
  assert.equal(n, 8)
  assert.deepEqual(leftOf(target, 8), [100, 101, 102, 103, 104, 105, 106, 107])

  const tail = new Float32Array(10 * 2)
  const m = src.extract(tail, 10, TOTAL - 4)
  assert.equal(m, 4, '파일 끝에서는 요청보다 적게 반환해야 SimpleFilter가 onEnd를 부른다')
  assert.equal(src.ended, true)
})

test('루프 켜짐: 한 번의 extract 안에서 B→A로 감긴다 (이음새 없음)', () => {
  const src = new LoopingBufferSource(fakeBuffer(TOTAL))
  src.loop = true
  src.loopStartFrame = START
  src.loopEndFrame = END

  // B 직전 5프레임 앞에서 12프레임 요청 → 5개 읽고 A로 감겨 7개 더
  const req = 12
  const target = new Float32Array(req * 2)
  const n = src.extract(target, req, END - 5)
  assert.equal(n, req, '루프 중에는 요청한 만큼 항상 채워야 스트림이 끊기지 않는다')
  assert.deepEqual(leftOf(target, req), [
    END - 5, END - 4, END - 3, END - 2, END - 1,
    START, START + 1, START + 2, START + 3, START + 4, START + 5, START + 6,
  ])
  assert.equal(src.ended, false)
})

test('루프 켜짐: 구간보다 긴 요청도 여러 바퀴 채운다', () => {
  const src = new LoopingBufferSource(fakeBuffer(TOTAL))
  src.loop = true
  src.loopStartFrame = START
  src.loopEndFrame = END

  const req = LEN * 2 + 17
  const target = new Float32Array(req * 2)
  const n = src.extract(target, req, START)
  assert.equal(n, req)
  const left = leftOf(target, req)
  // 모든 샘플이 [A, B) 안에 있어야 한다
  assert.ok(left.every((v) => v >= START && v < END), '루프 밖 샘플이 섞이면 안 된다')
  // 정확히 두 바퀴 + 17프레임
  assert.equal(left[0], START)
  assert.equal(left[LEN], START, '첫 바퀴 끝 다음은 다시 A')
  assert.equal(left[LEN * 2], START, '두 바퀴 끝 다음도 다시 A')
  assert.equal(left[req - 1], START + 16)
})

test('스테레오 인터리브: 좌우가 같은 프레임을 읽는다', () => {
  const src = new LoopingBufferSource(fakeBuffer(TOTAL))
  const target = new Float32Array(4 * 2)
  src.extract(target, 4, 50)
  assert.deepEqual(Array.from(target), [50, 50, 51, 51, 52, 52, 53, 53])
})

test('모노: 좌채널을 양쪽에 복제한다', () => {
  const src = new LoopingBufferSource(fakeBuffer(TOTAL, 1))
  const target = new Float32Array(3 * 2)
  const n = src.extract(target, 3, 7)
  assert.equal(n, 3)
  assert.deepEqual(Array.from(target), [7, 7, 8, 8, 9, 9])
})

test('servedFrame이 다음 읽을 원본 프레임을 가리킨다 (재생 헤드의 기준)', () => {
  const src = new LoopingBufferSource(fakeBuffer(TOTAL))
  src.loop = true
  src.loopStartFrame = START
  src.loopEndFrame = END

  src.extract(new Float32Array(10 * 2), 10, START)
  assert.equal(src.servedFrame, START + 10)

  // B를 3프레임 넘겨 요청하면 servedFrame은 A+3으로 접혀야 한다
  src.extract(new Float32Array(LEN * 2 + 3 * 2), LEN + 3, START)
  assert.equal(src.servedFrame, START + 3)
})

test('mapFrame: 단조 증가 position을 A-B 안으로 접는다', () => {
  const src = new LoopingBufferSource(fakeBuffer(TOTAL))
  src.loop = true
  src.loopStartFrame = START
  src.loopEndFrame = END

  assert.equal(src.mapFrame(START), START)
  assert.equal(src.mapFrame(END), START, 'B는 A로 접힌다')
  assert.equal(src.mapFrame(END + 7), START + 7)
  assert.equal(src.mapFrame(START + LEN * 5 + 2), START + 2)
  assert.equal(src.mapFrame(START - 100), START - 100, 'A 앞은 그대로 (진입 전)')
})

test('너무 짧은 구간은 루프로 취급하지 않는다 (0길이 무한정지 방지)', () => {
  const src = new LoopingBufferSource(fakeBuffer(TOTAL))
  src.loop = true
  src.loopStartFrame = 500
  src.loopEndFrame = 500 + MIN_LOOP_FRAMES - 1

  const target = new Float32Array(8 * 2)
  const n = src.extract(target, 8, 500)
  assert.equal(n, 8)
  // 루프가 무효화되어 그냥 앞으로 읽는다
  assert.deepEqual(leftOf(target, 8), [500, 501, 502, 503, 504, 505, 506, 507])
})

test('루프를 A 앞에서 시작하면 A까지 읽고 구간에 진입한다', () => {
  const src = new LoopingBufferSource(fakeBuffer(TOTAL))
  src.loop = true
  src.loopStartFrame = START
  src.loopEndFrame = END

  const req = 10
  const target = new Float32Array(req * 2)
  const n = src.extract(target, req, START - 4)
  assert.equal(n, req)
  assert.deepEqual(leftOf(target, req), [
    START - 4, START - 3, START - 2, START - 1,
    START, START + 1, START + 2, START + 3, START + 4, START + 5,
  ])
})

console.log(`\n${passed} passed`)
