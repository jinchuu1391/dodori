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
const CLICK_WAV = join(WORK, 'click-103.wav')

/* ---------- 1초마다 음이 바뀌는 8초짜리 테스트 음원 ---------- */
function makeWav(path, seconds = 8, rate = 44100) {
  const notes = [220, 277, 330, 440, 330, 277, 247, 220]
  writeWav(path, seconds * rate, rate, (i) => {
    const sec = Math.floor(i / rate)
    const f = notes[Math.min(notes.length - 1, sec)]
    // 소절마다 진폭 엔벌로프를 줘서 파형이 눈에 보이게
    const env = 0.35 + 0.45 * Math.abs(Math.sin((i / rate) * Math.PI))
    return Math.sin((2 * Math.PI * f * i) / rate) * env
  })
}

/* ---------- 자동 박 감지용: 일정한 BPM의 클릭 트랙(4박마다 높은 음) + 지속음 ---------- */
const CLICK_BPM = 103
const CLICK_OFFSET = 0.42
function makeClickWav(path, seconds = 16, rate = 44100) {
  const n = seconds * rate
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 196 * i) / rate)
  for (let k = 0; ; k++) {
    const t = CLICK_OFFSET + (k * 60) / CLICK_BPM
    if (t > seconds - 0.1) break
    const s0 = Math.round(t * rate)
    const f = k % 4 ? 900 : 1600
    for (let i = 0; i < rate * 0.05 && s0 + i < n; i++) x[s0 + i] += 0.8 * Math.exp(-i / (rate * 0.007)) * Math.sin((2 * Math.PI * f * i) / rate)
  }
  writeWav(path, n, rate, (i) => Math.max(-1, Math.min(1, x[i])))
}

/** 16bit 스테레오(좌우 같은 값) WAV. sampleAt(i)는 −1..1 */
function writeWav(path, n, rate, sampleAt) {
  const data = Buffer.alloc(n * 4) // 16bit stereo
  for (let i = 0; i < n; i++) {
    const v = Math.round(sampleAt(i) * 32767)
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
  check('이름을 입력해야 구간을 저장할 수 있다',
    await cdp.eval(`document.querySelector('.save-region button').disabled`))
  await cdp.eval(`window.__dodori.usePlayer.getState().saveSelectionAsRegion('   ')`)
  check('공백만 있는 제목은 저장되지 않는다',
    await cdp.eval(`document.querySelectorAll('.regions li').length`) === 0)
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

  /* 6-1. 재생 헤드가 떨리지 않고 고르게 움직이는지 — 화면 프레임마다 위치를 재서
   *       "흐른 시간만큼 나아갔는지"의 오차를 본다. 루프 되감기(큰 역행)는 뺀다 */
  const motion = JSON.parse(await cdp.eval(`(async () => {
    const { engine } = window.__dodori;
    const samples = [];
    await new Promise((done) => {
      const t0 = performance.now();
      const tick = (t) => {
        samples.push([t, engine.getPositionSec()]);
        if (t - t0 < 2500) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    let worst = 0, back = 0, n = 0, sumAbs = 0;
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i][0] - samples[i - 1][0]) / 1000;
      const dp = samples[i][1] - samples[i - 1][1];
      if (dp < -0.5) continue; // 루프 되감기
      const err = Math.abs(dp - dt);
      worst = Math.max(worst, err); sumAbs += err; n++;
      if (dp < -0.0005) back++;
    }
    return JSON.stringify({ n, worstMs: worst * 1000, meanMs: (sumAbs / n) * 1000, back });
  })()`))
  console.log(`      재생 헤드 프레임당 오차: 평균 ${motion.meanMs.toFixed(1)}ms · 최대 ${motion.worstMs.toFixed(1)}ms · 뒤로 간 프레임 ${motion.back}/${motion.n}`)
  check('재생 헤드가 떨리지 않고 고르게 움직인다', motion.worstMs < 8 && motion.back === 0,
    `최대 ${motion.worstMs.toFixed(1)}ms, 역행 ${motion.back}회 (기준: 8ms 미만, 역행 0)`)

  /* 6-2. 재생 ↔ 일시정지를 여러 번 반복해도 다시 재생하면 소리가 난다
   *      — 엔진 분석기로 실제 출력 샘플을 읽어 무음·NaN이 아닌지 본다 */
  const audible = JSON.parse(await cdp.eval(`(async () => {
    const { engine, usePlayer } = window.__dodori;
    const an = engine.getAnalyser();
    const buf = new Float32Array(an.fftSize);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const level = () => { an.getFloatTimeDomainData(buf); let m = 0, nan = 0;
      for (const v of buf) { if (Number.isNaN(v)) nan++; else m = Math.max(m, Math.abs(v)); } return { m, nan }; };
    const rounds = [];
    for (let i = 0; i < 6; i++) {
      // 매번 다른 시점에 일시정지 — 위치 추정값이 정수가 아닌 순간이 대부분이다
      await wait(173 + i * 61);
      await usePlayer.getState().togglePlay(); // 일시정지
      await wait(120);
      await usePlayer.getState().togglePlay(); // 다시 재생
      await wait(450);
      rounds.push(level());
    }
    return JSON.stringify(rounds);
  })()`))
  const silent = audible.filter((r) => r.m < 0.01 || r.nan > 0).length
  check('재생·일시정지를 반복해도 다시 재생하면 소리가 난다', silent === 0,
    `6번 중 무음 ${silent}번 · 최대 진폭 ${audible.map((r) => r.m.toFixed(2)).join(' ')}${audible.some((r) => r.nan) ? ' · NaN 섞임' : ''}`)

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

  /* 7-1. 재생 중(한 바퀴 이상 돈 뒤) B를 옮겨도 헤드가 튀지 않는다
   *      — 손잡이를 놓을 때와 같은 경로(setSelection commit)로 B를 바꾸고 전후 위치를 본다 */
  const bMove = JSON.parse(await cdp.eval(`(async () => {
    const { engine, usePlayer } = window.__dodori;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const sel = usePlayer.getState().selection;
    // 루프가 막 감긴 직후는 피한다(되감기 자체를 점프로 오인하지 않게): A+0.6초 ~ B-0.6초 사이에서
    for (let i = 0; i < 400; i++) {
      const p = engine.getPositionSec();
      if (p > sel.startSec + 0.6 && p < sel.endSec - 0.6) break;
      await frame();
    }
    const out = [];
    for (let i = 0; i < 20; i++) { await frame(); out.push([performance.now(), engine.getPositionSec()]); }
    usePlayer.getState().setSelection({ startSec: sel.startSec, endSec: sel.endSec + 1.0 }, true);
    for (let i = 0; i < 40; i++) { await frame(); out.push([performance.now(), engine.getPositionSec()]); }
    let worst = 0;
    for (let i = 1; i < out.length; i++) {
      const dt = (out[i][0] - out[i - 1][0]) / 1000;
      worst = Math.max(worst, Math.abs(out[i][1] - out[i - 1][1] - dt));
    }
    // 원래 구간으로 돌려 둔다
    usePlayer.getState().setSelection(sel, true);
    return JSON.stringify({ worstMs: worst * 1000, before: out[19][1], after: out[20][1] });
  })()`))
  check('재생 중 B를 옮겨도 재생 헤드가 튀지 않는다', bMove.worstMs < 30,
    `B 변경 직전 ${bMove.before.toFixed(2)}초 → 직후 ${bMove.after.toFixed(2)}초, 프레임당 최대 오차 ${bMove.worstMs.toFixed(0)}ms`)

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

  /* 10. 북마크 세로 목록 · 파형 높이 조절 */
  // 확대 화면에서 잡아 둔 구간을 두 번째 북마크로 저장
  await cdp.eval(`(() => {
    const i = document.querySelector('.save-region input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(i, '2절 끝');
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await sleep(150)
  await cdp.eval(`document.querySelector('.save-region button').click()`)
  await sleep(600)
  const rows = JSON.parse(await cdp.eval(`(() => {
    const ul = document.querySelector('.regions ul').getBoundingClientRect();
    return JSON.stringify({ ulW: ul.width, rows: [...document.querySelectorAll('.regions li')].map(li => {
      const r = li.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width };
    }) });
  })()`))
  const stacked = rows.rows.length === 2 && Math.abs(rows.rows[0].x - rows.rows[1].x) < 1 &&
    rows.rows[1].y > rows.rows[0].y && rows.rows.every((r) => r.w > rows.ulW - 4)
  check('북마크가 한 줄에 하나씩 세로로 쌓인다', stacked, rows.rows.map((r) => `y=${Math.round(r.y)} w=${Math.round(r.w)}`).join(' / '))

  // 저장 직후·북마크를 고른 상태에서는 입력창 대신 북마크 이름만 보인다
  const abState = () => cdp.eval(`JSON.stringify({
    form: !!document.querySelector('.drill .save-region'),
    saved: document.querySelector('.drill .ab-saved')?.textContent ?? null,
  })`).then(JSON.parse)
  const afterSave = await abState()
  check('저장한 구간은 입력창 대신 이름으로 보인다', !afterSave.form && afterSave.saved === '2절 끝', JSON.stringify(afterSave))
  await cdp.eval(`[...document.querySelectorAll('.regions li .go')][0].click()`)
  await sleep(300)
  const afterPick = await abState()
  check('북마크를 고르면 입력창 없이 그 이름이 보인다', !afterPick.form && afterPick.saved === '1절 고음', JSON.stringify(afterPick))
  // 눈금을 다시 드래그해 새 구간을 잡으면 입력창이 돌아온다
  const nb = JSON.parse(await cdp.eval(`(() => { const r = document.querySelector('.wave-wrap').getBoundingClientRect();
    return JSON.stringify({ x: r.left, y: r.top, w: r.width }); })()`))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nb.x + nb.w * 0.7, y: nb.y + 12, button: 'left', clickCount: 1, pointerType: 'mouse' })
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nb.x + nb.w * (0.7 + 0.02 * i), y: nb.y + 12, button: 'left', pointerType: 'mouse' })
    await sleep(20)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nb.x + nb.w * 0.82, y: nb.y + 12, button: 'left', clickCount: 1, pointerType: 'mouse' })
  await sleep(300)
  const afterDrag = await abState()
  check('새 구간을 잡으면 입력창이 다시 나온다', afterDrag.form && afterDrag.saved === null, JSON.stringify(afterDrag))

  const stageH = () => cdp.eval(`document.querySelector('.stage').getBoundingClientRect().height`)
  const h0 = await stageH()
  const handle = JSON.parse(await cdp.eval(`(() => {
    const r = document.querySelector('.stage-resize').getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`))
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1, pointerType: 'mouse' })
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y + (80 * i) / 8, button: 'left', pointerType: 'mouse' })
    await sleep(20)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x, y: handle.y + 80, button: 'left', clickCount: 1, pointerType: 'mouse' })
  await sleep(300)
  const h1 = await stageH()
  check('파형 아래 끝을 끌면 높이가 바뀐다', Math.abs(h1 - h0 - 80) < 2, `${Math.round(h0)}px → ${Math.round(h1)}px (+80 기대)`)

  await cdp.send('Page.captureScreenshot', { format: 'png' })
    .then((r) => writeFileSync(SHOT.replace(/\.png$/, '-layout.png'), Buffer.from(r.data, 'base64')))

  await cdp.send('Page.navigate', { url: APP })
  await sleep(3000)
  const h2 = await stageH()
  check('파형 높이를 새로고침 후에도 기억한다', Math.abs(h2 - h1) < 2, `${Math.round(h2)}px`)

  /* 11. 메트로놈 */
  const key = async (k, code, vk) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  }
  const metro = () => cdp.eval(`JSON.stringify({
    grid: window.__dodori.usePlayer.getState().beatGrid,
    on: window.__dodori.usePlayer.getState().metronomeOn,
    clicks: window.__dodori.engine.clickCount,
    anchorText: document.querySelector('.metro-anchor-time')?.textContent,
    hint: document.querySelector('.metro .hint')?.textContent,
  })`).then(JSON.parse)
  const clickBtn = (sel, shift = false) => cdp.eval(`document.querySelector('${sel}').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: ${shift} }))`)

  const m0 = await metro()
  check('메트로놈은 처음에 꺼져 있고 박 기준이 없다', !m0.on && m0.grid === null && /첫 박 찍기/.test(m0.hint ?? ''), m0.hint)

  // 재생하며 T를 한 번 → 그 순간 위치가 1박, BPM은 기본 120
  await cdp.eval(`window.__dodori.usePlayer.getState().seek(0)`)
  await key(' ', 'Space', 32)
  await sleep(1200)
  const posAtTap = await cdp.eval(`window.__dodori.engine.getPositionSec()`)
  await key('t', 'KeyT', 84)
  await sleep(100)
  const m1 = await metro()
  check('T 한 번으로 지금 위치가 첫 박이 된다', m1.grid && Math.abs(m1.grid.anchorSec - posAtTap) < 0.1 && m1.grid.bpm === 120,
    `첫 박 ${m1.grid?.anchorSec.toFixed(3)}초 (누를 때 ${posAtTap.toFixed(3)}초) · ${m1.grid?.bpm} BPM · 표시 ${m1.anchorText}`)

  // BPM −/+ 는 1씩, 첫 박은 그대로
  await clickBtn('.metro-bpm button[aria-label="BPM 1 올리기"]')
  await clickBtn('.metro-bpm button[aria-label="BPM 1 올리기"]')
  await clickBtn('.metro-bpm button[aria-label="BPM 1 내리기"]')
  await sleep(100)
  const m1b = await metro()
  check('BPM −/+ 로 1씩 바뀌고 첫 박은 그대로', m1b.grid.bpm === 121 && m1b.grid.anchorSec === m1.grid.anchorSec, `${m1b.grid.bpm} BPM`)

  // 첫 박 ◀ ▶ : 10ms, Shift 1ms
  await clickBtn('.metro-anchor button[aria-label="첫 박 뒤로"]')
  await clickBtn('.metro-anchor button[aria-label="첫 박 뒤로"]')
  await clickBtn('.metro-anchor button[aria-label="첫 박 앞으로"]', true)
  await sleep(100)
  const m1c = await metro()
  const nudged = m1c.grid.anchorSec - m1b.grid.anchorSec
  check('첫 박을 10ms(Shift 1ms)씩 옮길 수 있다', Math.abs(nudged - 0.019) < 0.0002, `+10 +10 −1 = ${(nudged * 1000).toFixed(1)}ms · 표시 ${m1c.anchorText}`)

  // 결정적인 값으로: 60 BPM, 0.5초가 1박 → 1초에 한 번
  await cdp.eval(`window.__dodori.usePlayer.getState().setBeatGrid({ bpm: 60, anchorSec: 0.5, beatsPerBar: 4 })`)
  await cdp.eval(`document.querySelector('.metro .toggle input').click()`)
  await cdp.eval(`window.__dodori.usePlayer.getState().seek(0.2)`)
  await sleep(200)
  const c0 = (await metro()).clicks
  await sleep(3000)
  const c1 = (await metro()).clicks
  check('메트로놈을 켜면 BPM대로 클릭한다', c1 - c0 >= 2 && c1 - c0 <= 4, `3초에 ${c1 - c0}번 (60 BPM → 3번 기대)`)

  await cdp.eval(`window.__dodori.usePlayer.getState().setSpeed(0.5)`)
  await sleep(300)
  const c2 = (await metro()).clicks
  await sleep(4000)
  const c3 = (await metro()).clicks
  check('느리게 재생하면 클릭도 느려진다', c3 - c2 >= 1 && c3 - c2 <= 3, `0.5×에서 4초에 ${c3 - c2}번 (2번 기대)`)
  const slowHint = (await metro()).hint
  check('느린 속도에선 정확도 안내가 보인다', /어긋날 수/.test(slowHint ?? ''), slowHint)
  await cdp.eval(`window.__dodori.usePlayer.getState().setSpeed(1)`)
  await key(' ', 'Space', 32) // 정지
  await sleep(300)

  // 박자 선(1.5초, 마디 둘째 박) 끌기 → 격자 전체가 옮겨진다. 화면 이동·구간 선택은 일어나지 않는다
  const mb = JSON.parse(await cdp.eval(`(() => { const el = document.querySelector('.wave-wrap'); const r = el.getBoundingClientRect();
    return JSON.stringify({ x: r.left, y: r.top, w: r.width, h: r.height, vs: +el.dataset.viewStart, vspan: +el.dataset.viewSpan }); })()`))
  const lineX = mb.x + ((1.5 - mb.vs) / mb.vspan) * mb.w
  const selBefore = await cdp.eval(`JSON.stringify(window.__dodori.usePlayer.getState().selection)`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: lineX, y: mb.y + mb.h * 0.6, button: 'left', clickCount: 1, pointerType: 'mouse' })
  for (let i = 1; i <= 8; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: lineX + 5 * i, y: mb.y + mb.h * 0.6, button: 'left', pointerType: 'mouse' })
    await sleep(20)
  }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: lineX + 40, y: mb.y + mb.h * 0.6, button: 'left', clickCount: 1, pointerType: 'mouse' })
  await sleep(300)
  const m2 = await metro()
  const vAfter = await viewOf()
  const expShift = (40 / mb.w) * mb.vspan
  check('박자 선을 끌면 첫 박이 옮겨진다', Math.abs(m2.grid.anchorSec - (0.5 + expShift)) < 0.02,
    `기준 0.5 → ${m2.grid.anchorSec.toFixed(3)}초 (기대 ${(0.5 + expShift).toFixed(3)})`)
  check('박자 선 드래그는 화면 이동·구간 선택을 하지 않는다',
    Math.abs(vAfter.start - mb.vs) < 1e-3 && (await cdp.eval(`JSON.stringify(window.__dodori.usePlayer.getState().selection)`)) === selBefore,
    `화면 시작 ${vAfter.start}`)

  // 확대해도 박자 선이 파형 위에 보인다 — 선 자리와 바로 옆의 픽셀 색을 비교한다
  // (헤드리스 Chrome은 위 키 입력 중 어딘가에서 페이지를 hidden으로 돌려 화면 프레임을 멈춘다.
  //  그러면 마우스·휠 입력이 프레임을 기다리다 시간 초과가 나므로 다시 앞으로 가져온다)
  await cdp.send('Page.bringToFront')
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await sleep(200)
  const beatSec = m2.grid.anchorSec + 2 // 2박 뒤
  const bx0 = mb.x + ((beatSec - mb.vs) / mb.vspan) * mb.w
  for (let i = 0; i < 3; i++) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: bx0, y: mb.y + mb.h * 0.5, deltaX: 0, deltaY: -250 })
    await sleep(60)
  }
  await sleep(300)
  const zv = await viewOf()
  const beatVis = JSON.parse(await cdp.eval(`(() => {
    const c = document.querySelector('.wave-wrap canvas');
    const rect = c.getBoundingClientRect();
    const dpr = c.width / rect.width;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const x = Math.round(((${beatSec} - ${zv.start}) / ${zv.span}) * rect.width);
    // 파형 진한 띠가 있는 가운데 높이에서, 열 cx의 픽셀이 열 ref와 눈에 띄게 다른 비율(색과 무관)
    const differs = (cx, ref) => { let n = 0, t = 0; const a = Math.round(cx * dpr), b = Math.round(ref * dpr);
      for (let y = Math.round(c.height * 0.4); y < Math.round(c.height * 0.6); y++) {
        const o = (y * c.width + a) * 4, q = (y * c.width + b) * 4; t++;
        if (Math.abs(d[o] - d[q]) + Math.abs(d[o + 1] - d[q + 1]) + Math.abs(d[o + 2] - d[q + 2]) > 40) n++; }
      return n / t; };
    // 선 자리 vs 6px 옆, 그리고 대조로 선 없는 두 열(6px 옆 vs 12px 옆)
    return JSON.stringify({ on: differs(x, x + 6), beside: differs(x + 6, x + 12), zoom: (8 / ${zv.span}).toFixed(1) });
  })()`))
  check('확대해도 박자 선이 파형 위에 보인다', beatVis.on > 0.8 && beatVis.beside < 0.1,
    `${beatVis.zoom}× 확대 · 선 자리가 옆과 다른 픽셀 ${(beatVis.on * 100).toFixed(0)}% (선 없는 두 열끼리는 ${(beatVis.beside * 100).toFixed(0)}%)`)
  await cdp.send('Page.captureScreenshot', { format: 'png' })
    .then((r) => writeFileSync(SHOT.replace(/\.png$/, '-beatzoom.png'), Buffer.from(r.data, 'base64')))
  await cdp.eval(`document.querySelector('.wave-fit')?.click()`)
  await sleep(200)

  // 구간에 저장한 박 격자는 새로고침 후 그 구간을 고르면 돌아온다
  await cdp.eval(`window.__dodori.usePlayer.getState().setSelection({ startSec: 5.2, endSec: 7.1 })`)
  await sleep(100)
  await cdp.eval(`window.__dodori.usePlayer.getState().setBeatGrid({ bpm: 96.5, anchorSec: 5.31, beatsPerBar: 3 })`)
  await cdp.eval(`window.__dodori.usePlayer.getState().saveSelectionAsRegion('박자 구간')`)
  await sleep(500)
  await cdp.send('Page.navigate', { url: APP })
  await sleep(3000)
  await cdp.eval(`[...document.querySelectorAll('.regions li')].find(li => li.textContent.includes('박자 구간')).querySelector('.go').click()`)
  await sleep(300)
  const m3 = await metro()
  check('구간에 저장한 박 설정이 새로고침 후에도 돌아온다',
    m3.grid && m3.grid.bpm === 96.5 && Math.abs(m3.grid.anchorSec - 5.31) < 1e-6 && m3.grid.beatsPerBar === 3, JSON.stringify(m3.grid))

  // 자동 박 감지 — 클릭 트랙을 넣고 "자동"을 누르면 BPM · 첫 박이 채워지고 메트로놈이 켜진다
  makeClickWav(CLICK_WAV)
  await cdp.eval(`window.__dodori.usePlayer.getState().setMetronomeOn(false)`)
  {
    const { root: r2 } = await cdp.send('DOM.getDocument')
    const { nodeId: fileNode } = await cdp.send('DOM.querySelector', { nodeId: r2.nodeId, selector: 'input[type=file]' })
    await cdp.send('DOM.setFileInputFiles', { nodeId: fileNode, files: [CLICK_WAV] })
  }
  let clickLoaded = false
  for (let i = 0; i < 40 && !clickLoaded; i++) {
    await sleep(250)
    clickLoaded = await cdp.eval(`(() => { const s = window.__dodori.usePlayer.getState(); return s.song?.title === 'click-103' && !!s.buffer })()`)
  }
  check('자동 감지용 클릭 트랙을 연다', clickLoaded)
  const autoBtn = `[...document.querySelectorAll('.metro .metro-mark')].find((b) => b.textContent.includes('자동'))`
  const t0 = Date.now()
  await cdp.eval(`${autoBtn}.click()`)
  await sleep(100)
  const busy = await cdp.eval(`${autoBtn}?.disabled ?? true`)
  let detectDone = false
  for (let i = 0; i < 120 && !detectDone; i++) {
    await sleep(250)
    detectDone = await cdp.eval(`!window.__dodori.usePlayer.getState().beatDetecting`)
  }
  const ms = Date.now() - t0
  const m4 = await metro()
  const err4 = await cdp.eval(`window.__dodori.usePlayer.getState().error`)
  const P = 60 / CLICK_BPM
  const phaseErr = m4.grid ? ((m4.grid.anchorSec - CLICK_OFFSET) / P - Math.round((m4.grid.anchorSec - CLICK_OFFSET) / P)) * P * 1000 : NaN
  check('"자동"을 누르면 분석하는 동안 버튼이 잠긴다', busy === true)
  check('"자동"으로 BPM을 찾는다', detectDone && m4.grid && Math.abs(m4.grid.bpm - CLICK_BPM) < 0.1,
    `${m4.grid?.bpm} BPM (정답 ${CLICK_BPM}) · ${ms}ms${err4 ? ' · ' + err4 : ''}`)
  check('"자동"으로 찾은 첫 박이 실제 박과 3ms 안에서 맞는다', Math.abs(phaseErr) < 3,
    `첫 박 ${m4.grid?.anchorSec.toFixed(4)}초 · 어긋남 ${phaseErr.toFixed(2)}ms`)
  check('자동 감지 후 메트로놈이 켜진다', m4.on)

  await clickBtn('.metro-bpm .metro-wide[title="빠르기를 두 배로"]')
  await sleep(50)
  const m5 = await metro()
  check('×2 는 BPM을 정확히 두 배로 (반올림 없이)', m5.grid.bpm === m4.grid.bpm * 2, `${m4.grid.bpm} → ${m5.grid.bpm}`)
  await clickBtn('.metro-bpm .metro-wide[title="빠르기를 절반으로"]')
  await clickBtn('.metro-anchor .metro-wide')
  await sleep(50)
  const m6 = await metro()
  check('"강박 →"은 첫 박을 정확히 한 박 뒤로', m6.grid.bpm === m4.grid.bpm && Math.abs(m6.grid.anchorSec - m4.grid.anchorSec - 60 / m4.grid.bpm) < 1e-3,
    `${m4.grid.anchorSec.toFixed(4)} → ${m6.grid.anchorSec.toFixed(4)}초`)

  await cdp.send('Page.captureScreenshot', { format: 'png' })
    .then((r) => writeFileSync(SHOT.replace(/\.png$/, '-metro.png'), Buffer.from(r.data, 'base64')))

  /* 북마크를 반복에 추가해서 떨어진 구간을 이어 재생한다. */
  await cdp.eval(`(async () => {
    const player = window.__dodori.usePlayer.getState;
    for (const [label, startSec, endSec] of [['첫 구간', 1, 2], ['다음 구간', 4, 5]]) {
      player().setSelection({ startSec, endSec });
      await player().saveSelectionAsRegion(label);
    }
    document.querySelector('.regions .go').click();
    await player().togglePlay();
    document.querySelector('[aria-label="다음 구간 반복에 추가"]').click();
  })()`)
  check('선택한 북마크에 반복 순서가 표시된다',
    await cdp.eval(`[...document.querySelectorAll('.r-order')].map(el => el.textContent).join(',')`) === '1,2')
  const visited = []
  for (let i = 0; i < 60; i++) {
    const position = await cdp.eval(`window.__dodori.engine.getPositionSec()`)
    visited.push(position)
    if (visited.some((p) => p >= 4 && p < 5) && position >= 1 && position < 2) break
    await sleep(50)
  }
  const secondVisit = visited.findIndex((p) => p >= 4 && p < 5)
  check('재생 헤드가 빈 구간을 건너뛰고 첫 구간으로 돌아온다',
    secondVisit > 0 && visited.at(-1) < 2 && visited.every((p) => (p >= 1 && p < 2) || (p >= 4 && p < 5)))
  await cdp.eval(`document.querySelector('[aria-label="다음 구간 반복에서 빼기"]').click()`)
  check('다음 북마크를 빼면 첫 북마크만 반복한다',
    await cdp.eval(`window.__dodori.usePlayer.getState().loopRegionIds.length`) === 1)

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
