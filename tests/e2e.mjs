/**
 * 도돌이 M1 엔드투엔드 구동.
 *
 * Chrome DevTools Protocol로 실제 브라우저를 몰아서:
 *   파일 넣기 → 파형 렌더 → 드래그로 A-B → 스페이스로 재생 → 새로고침 후 복원까지.
 *
 * 사용법:
 *   1) 다른 터미널에서  npm run dev
 *   2) npm run test:e2e
 *
 * Chrome 경로는 CHROME 환경변수로 바꿀 수 있다.
 * 브라우저를 눈으로 보려면  HEADED=1 npm run test:e2e
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const APP = process.env.APP_URL ?? 'http://localhost:5173/'
const PORT = 9222
const CDP = `http://localhost:${PORT}`
const CHROME =
  process.env.CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome')

const WORK = mkdtempSync(join(tmpdir(), 'dodori-e2e-'))
const WAV = join(WORK, 'test-tone.wav')
const SHOT = join(WORK, 'app.png')

/* ---------- 1초마다 음이 바뀌는 8초짜리 테스트 음원 ---------- */
function makeWav(path, seconds = 8, rate = 44100) {
  const n = seconds * rate
  const notes = [220, 277, 330, 440, 330, 277, 247, 220]
  const data = Buffer.alloc(n * 4) // 16bit stereo
  for (let i = 0; i < n; i++) {
    const sec = Math.floor(i / rate)
    const f = notes[Math.min(notes.length - 1, sec)]
    // 소절마다 진폭 엔벌로프를 줘서 파형이 눈에 보이게
    const env = 0.35 + 0.45 * Math.abs(Math.sin((i / rate) * Math.PI))
    const v = Math.round(Math.sin((2 * Math.PI * f * i) / rate) * 32767 * env)
    data.writeInt16LE(v, i * 4)
    data.writeInt16LE(v, i * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

/* ---------- 최소 CDP 클라이언트 ---------- */
class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.consoleErrors = []
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text))
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push('console.error: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '))
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`timeout: ${method}`))
        }
      }, 15000)
    })
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed')
    return r.result.value
  }
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 개발 서버가 떠 있는지, Chrome을 띄울 수 있는지 준비 */
async function boot() {
  try {
    await fetch(APP)
  } catch {
    console.error(`개발 서버가 없습니다: ${APP}\n  다른 터미널에서 'npm run dev'를 먼저 실행하세요.`)
    process.exit(1)
  }

  const chrome = spawn(
    CHROME,
    [
      ...(process.env.HEADED ? [] : ['--headless=new']),
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${join(WORK, 'profile')}`,
      `--remote-debugging-port=${PORT}`,
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      await fetch(`${CDP}/json/version`)
      return chrome
    } catch {
      /* 아직 안 떴다 */
    }
  }
  chrome.kill()
  throw new Error('Chrome 디버깅 포트가 열리지 않았습니다')
}

/** 중간에 실패해도 Chrome이 남지 않도록 바깥에 잡아둔다 */
let chrome = null

async function main() {
  chrome = await boot()
  makeWav(WAV)
  console.log(`테스트 음원 생성: 8초, 1초마다 음 변화\n`)

  const targets = await (await fetch(`${CDP}/json`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('page target 없음')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const cdp = new Cdp(ws)

  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('DOM.enable')

  await cdp.send('Page.navigate', { url: APP })
  await sleep(2500)

  /* 1. 첫 화면 */
  const shell = await cdp.eval(`JSON.stringify({
    topbar: !!document.querySelector('.topbar'),
    library: !!document.querySelector('.library'),
    transport: !!document.querySelector('.transport'),
    empty: document.querySelector('.wave-empty')?.textContent?.trim() ?? null,
    title: document.title,
  })`)
  const s = JSON.parse(shell)
  check('앱 셸이 렌더된다', s.topbar && s.library && s.transport, s.title)
  check('곡 없을 때 안내가 보인다', !!s.empty, s.empty?.slice(0, 24) + '…')

  /* 2. 파일 넣기 */
  const { root } = await cdp.send('DOM.getDocument')
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [WAV] })

  let loaded = false
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    loaded = await cdp.eval(`document.querySelectorAll('.song-list li').length > 0`)
    if (loaded) break
  }
  check('파일을 넣으면 라이브러리에 곡이 생긴다', loaded)

  const songInfo = await cdp.eval(`JSON.stringify({
    title: document.querySelector('.s-title')?.textContent,
    dur: document.querySelector('.s-meta')?.textContent,
    canvases: document.querySelectorAll('.wave-wrap canvas').length,
    nowTitle: document.querySelector('.now .title')?.textContent,
    total: document.querySelectorAll('.now .clock span')[2]?.textContent,
  })`)
  const si = JSON.parse(songInfo)
  check('곡 길이를 읽는다', si.dur === '0:08.0', `표시: ${si.dur}`)
  check('파형 캔버스 2겹이 붙는다', si.canvases === 2, `${si.canvases}개`)
  check('트랜스포트에 곡이 실린다', si.nowTitle === 'test-tone', `${si.nowTitle} / ${si.total}`)

  /* 3. 파형이 실제로 그려졌는지 — 캔버스 픽셀을 본다 */
  const drawn = await cdp.eval(`(() => {
    const c = document.querySelector('.wave-wrap canvas');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
    return painted;
  })()`)
  check('파형 픽셀이 실제로 그려졌다', drawn > 1000, `불투명 픽셀 ${drawn.toLocaleString()}개`)

  /* 4. 위쪽 시간 눈금을 드래그해 A-B 구간 선택 (파형 영역 드래그는 좌우 이동) */
  const box = JSON.parse(await cdp.eval(`(() => {
    const r = document.querySelector('.wave-wrap').getBoundingClientRect();
    return JSON.stringify({x: r.left, y: r.top, w: r.width, h: r.height});
  })()`))
  const y = box.y + 12 // 눈금 띠(26px) 안
  const x1 = box.x + box.w * 0.25
  const x2 = box.x + box.w * 0.6

  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y, button: 'left', clickCount: 1, pointerType: 'mouse' })
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 8, y, button: 'left', pointerType: 'mouse' })
    await sleep(20)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y, button: 'left', clickCount: 1, pointerType: 'mouse' })
  await sleep(400)

  const sel = JSON.parse(await cdp.eval(`JSON.stringify({
    chips: [...document.querySelectorAll('.drill .chip')].map(e => e.textContent.trim()),
    len: document.querySelector('.drill .len')?.textContent,
  })`))
  check('눈금을 드래그하면 A-B 구간이 잡힌다', sel.chips.length === 2, sel.chips.join(' → '))
  // 화면 25%~60% ≈ 8초의 2.0s~4.8s ≈ 2.8초
  const lenNum = parseFloat(sel.len ?? '0')
  check('구간 길이가 드래그 폭과 맞는다', lenNum > 2.4 && lenNum < 3.2, `${sel.len} (기대 ≈2.8초)`)

  /* 5. 구간 저장 */
  await cdp.eval(`(() => {
    const i = document.querySelector('.save-region input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(i, '1절 고음');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.save-region button').click()`)
  await sleep(600)
  const saved = JSON.parse(await cdp.eval(`JSON.stringify([...document.querySelectorAll('.regions li .r-label')].map(e=>e.textContent))`))
  check('구간을 북마크로 저장한다', saved.includes('1절 고음'), saved.join(', '))

  /* 6. 재생 — 스페이스바 */
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
  await sleep(500)
  const playing = await cdp.eval(`document.querySelector('.play').textContent`)
  check('스페이스바로 재생 상태가 된다', playing !== '▶', `버튼: ${playing}`)

  const t1 = await cdp.eval(`document.querySelector('.now .cur').textContent`)
  await sleep(1400)
  const t2 = await cdp.eval(`document.querySelector('.now .cur').textContent`)
  const ctxState = await cdp.eval(`(() => 'ok')()`)
  check('재생 위치가 전진한다', t1 !== t2, `${t1} → ${t2}`, ctxState)

  /* 7. 루프가 A-B 안에 머무는지 */
  const inLoop = await cdp.eval(`(() => {
    const cur = document.querySelector('.now .cur').textContent;
    const chips = [...document.querySelectorAll('.drill .chip')].map(e=>e.textContent.trim());
    return JSON.stringify({cur, chips});
  })()`)
  const il = JSON.parse(inLoop)
  const toSec = (t) => { const m = t.match(/(\d+):(\d+)\.(\d)/); return m ? +m[1]*60 + +m[2] + +m[3]/10 : NaN }
  const a = toSec(il.chips[0].replace('A ', ''))
  const b = toSec(il.chips[1].replace('B ', ''))
  const cur = toSec(il.cur)
  check('재생 헤드가 A-B 구간 안에 있다', cur >= a - 0.3 && cur <= b + 0.3, `A=${a} 헤드=${cur} B=${b}`)

  /* 8. 새로고침 후에도 곡과 구간이 남는지 (IndexedDB) */
  await cdp.send('Page.navigate', { url: APP })
  await sleep(3000)
  const persisted = JSON.parse(await cdp.eval(`JSON.stringify({
    songs: document.querySelectorAll('.song-list li').length,
    regions: [...document.querySelectorAll('.regions li .r-label')].map(e=>e.textContent),
    nowTitle: document.querySelector('.now .title')?.textContent,
  })`))
  check('새로고침해도 곡이 남는다 (IndexedDB)', persisted.songs === 1, `${persisted.songs}곡`)
  check('마지막 곡을 자동으로 다시 연다', persisted.nowTitle === 'test-tone', persisted.nowTitle)
  check('저장한 구간도 복원된다', persisted.regions.includes('1절 고음'), persisted.regions.join(', '))

  /* 9. 휠 확대/축소 · 좌우 이동 */
  const wbox = JSON.parse(await cdp.eval(`(() => {
    const r = document.querySelector('.wave-wrap').getBoundingClientRect();
    return JSON.stringify({x: r.left, y: r.top, w: r.width, h: r.height});
  })()`))
  const viewOf = async () => JSON.parse(await cdp.eval(`(() => {
    const el = document.querySelector('.wave-wrap');
    return JSON.stringify({ start: +el.dataset.viewStart, span: +el.dataset.viewSpan,
      fit: document.querySelector('.wave-fit')?.textContent ?? null });
  })()`))
  const wy = wbox.y + wbox.h / 2
  const v0 = await viewOf()
  check('처음엔 곡 전체가 보인다', Math.abs(v0.span - 8) < 0.01 && v0.fit === null, `범위 ${v0.start}~${v0.start + v0.span}초`)

  // 화면 75% 지점(=6초)에서 휠을 위로 세 번
  const ax = wbox.x + wbox.w * 0.75
  for (let i = 0; i < 3; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ax, y: wy, deltaX: 0, deltaY: -200 })
    await sleep(60)
  }
  await sleep(200)
  const v1 = await viewOf()
  const anchor1 = v1.start + 0.75 * v1.span
  check('휠을 올리면 확대된다', v1.span < 8 * 0.6 && v1.fit !== null, `보이는 길이 ${v1.span.toFixed(2)}초 · ${v1.fit}`)
  check('마우스 아래 지점이 제자리에 남는다', Math.abs(anchor1 - 6) < 0.05, `75% 지점 = ${anchor1.toFixed(3)}초 (기대 6초)`)

  const zoomPx = await cdp.eval(`(() => {
    const c = document.querySelector('.wave-wrap canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n;
  })()`)
  check('확대 상태에서도 파형이 그려진다', zoomPx > 1000, `불투명 픽셀 ${zoomPx.toLocaleString()}개`)

  // 확대한 화면에서 눈금을 10%~30% 드래그 → 구간 길이는 보이는 길이의 20%
  const zx1 = wbox.x + wbox.w * 0.1
  const zx2 = wbox.x + wbox.w * 0.3
  const ry = wbox.y + 12
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: zx1, y: ry, button: 'left', clickCount: 1, pointerType: 'mouse' })
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: zx1 + ((zx2 - zx1) * i) / 8, y: ry, button: 'left', pointerType: 'mouse' })
    await sleep(20)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zx2, y: ry, button: 'left', clickCount: 1, pointerType: 'mouse' })
  await sleep(300)
  const zsel = JSON.parse(await cdp.eval(`JSON.stringify([...document.querySelectorAll('.drill .chip')].map(e => e.textContent.trim()))`))
  const za = toSec(zsel[0]?.replace('A ', '') ?? '')
  const zb = toSec(zsel[1]?.replace('B ', '') ?? '')
  const expA = v1.start + 0.1 * v1.span
  const expLen = 0.2 * v1.span
  check('확대한 화면에서 눈금으로 잡은 구간이 화면 좌표와 맞는다',
    Math.abs(za - expA) < 0.15 && Math.abs(zb - za - expLen) < 0.15,
    `A=${za} B=${zb} (기대 A≈${expA.toFixed(2)}, 길이≈${expLen.toFixed(2)})`)

  await cdp.send('Page.captureScreenshot', { format: 'png' })
    .then((r) => writeFileSync(SHOT.replace(/\.png$/, '-zoom.png'), Buffer.from(r.data, 'base64')))

  // 파형 영역을 60% → 40%로 끌기 → 화면이 보이는 길이의 20%만큼 뒤로, 구간은 그대로
  const px1 = wbox.x + wbox.w * 0.6
  const px2 = wbox.x + wbox.w * 0.4
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px1, y: wy, button: 'left', clickCount: 1, pointerType: 'mouse' })
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px1 + ((px2 - px1) * i) / 8, y: wy, button: 'left', pointerType: 'mouse' })
    await sleep(20)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px2, y: wy, button: 'left', clickCount: 1, pointerType: 'mouse' })
  await sleep(300)
  const vp = await viewOf()
  const psel = JSON.parse(await cdp.eval(`JSON.stringify([...document.querySelectorAll('.drill .chip')].map(e => e.textContent.trim()))`))
  check('파형을 드래그하면 좌우로 이동한다', Math.abs(vp.start - v1.start - 0.2 * v1.span) < 0.02 && Math.abs(vp.span - v1.span) < 0.001,
    `시작 ${v1.start.toFixed(2)} → ${vp.start.toFixed(2)}초 (기대 +${(0.2 * v1.span).toFixed(2)})`)
  check('파형 드래그는 구간을 바꾸지 않는다', psel.join() === zsel.join(), psel.join(' → '))

  // 트랙패드 가로 스와이프 → 오른쪽으로 이동, 배율은 그대로
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ax, y: wy, deltaX: 150, deltaY: 0 })
  await sleep(200)
  const v2 = await viewOf()
  check('가로 스크롤로 좌우 이동한다', v2.start > vp.start + 0.01 && Math.abs(v2.span - v1.span) < 0.001,
    `시작 ${vp.start.toFixed(2)} → ${v2.start.toFixed(2)}초`)

  // (좌우 이동 때 막대가 흔들리지 않는지는 tests/waveform.test.ts에서 타악기 같은 신호로 본다.
  //  여기 테스트음은 부드러운 사인파라 흔들림이 드러나지 않는다)

  // 많이 축소하면 곡 전체에서 멈춘다
  for (let i = 0; i < 6; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ax, y: wy, deltaX: 0, deltaY: 400 })
    await sleep(40)
  }
  await sleep(200)
  const v3 = await viewOf()
  check('축소는 곡 전체에서 멈춘다', Math.abs(v3.span - 8) < 0.01 && v3.start === 0 && v3.fit === null, `범위 ${v3.start}~${v3.span}초`)

  // 다시 확대 후 '전체 보기' 버튼
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ax, y: wy, deltaX: 0, deltaY: -300 })
    await sleep(40)
  }
  await sleep(200)
  await cdp.eval(`document.querySelector('.wave-fit')?.click()`)
  await sleep(200)
  const v4 = await viewOf()
  check('전체 보기 버튼으로 돌아온다', Math.abs(v4.span - 8) < 0.01 && v4.fit === null, `범위 ${v4.start}~${v4.span}초`)

  /* 콘솔 에러 */
  const noise = cdp.consoleErrors.filter((e) => !/DevTools|favicon|AudioContext was not allowed/.test(e))
  check('페이지 콘솔에 에러가 없다', noise.length === 0, noise.slice(0, 3).join(' | ') || '깨끗')

  await cdp
    .send('Page.captureScreenshot', { format: 'png' })
    .then((r) => writeFileSync(SHOT, Buffer.from(r.data, 'base64')))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 통과`)
  console.log(`스크린샷: ${SHOT}`)
  ws.close()
  chrome.kill()
  return failed.length
}

main()
  .then(async (failed) => {
    // Chrome이 프로필에 쓰기를 끝낼 때까지 잠깐 기다린다. 스크린샷은 남긴다
    await sleep(500)
    rmSync(join(WORK, 'profile'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    process.exit(failed ? 1 : 0)
  })
  .catch((e) => {
    console.error('구동 실패:', e.message)
    chrome?.kill()
    process.exit(1)
  })
