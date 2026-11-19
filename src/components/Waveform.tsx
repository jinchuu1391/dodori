import { useCallback, useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { columnLevels } from '../audio/peaks'
import { usePlayer } from '../store/usePlayer'
import { formatTime } from '../util/time'

const HANDLE_HIT_PX = 9
const DRAG_THRESHOLD_PX = 3
const MIN_SELECTION_SEC = 0.05
/** 최대 확대 — 화면 전체가 0.1초 */
const MIN_VIEW_SEC = 0.1
/** 휠 한 칸(약 100px)에 약 1.28배. 트랙패드 핀치는 delta가 작아서 더 민감하게 */
const ZOOM_PER_PX = 0.0025
const PINCH_ZOOM_PER_PX = 0.01
/** 위쪽 시간 눈금 띠 — 여기를 드래그하면 A-B 구간을 잡는다 */
const RULER_H = 26

/** 화면에 보이는 시간 범위 */
interface View {
  start: number
  span: number
}

function clampView(start: number, span: number, duration: number): View {
  const s = Math.max(Math.min(MIN_VIEW_SEC, duration), Math.min(duration, span))
  return { start: Math.max(0, Math.min(duration - s, start)), span: s }
}

/** 화면 폭에 눈금이 targetTicks개 안쪽으로 들어가는 가장 촘촘한 간격 */
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]

/**
 * new  : 눈금 띠 드래그 → 새 A-B 구간
 * start/end : A·B 경계선 근처(위아래 어디든) 드래그 → 경계 조정
 * pan  : 파형 영역 드래그 → 좌우 이동(손으로 잡아 끄는 방향)
 */
type DragMode = 'new' | 'start' | 'end' | 'pan'
interface DragState {
  mode: DragMode
  anchorSec: number
  startX: number
  startView: View
  moved: boolean
}

interface Colors {
  bar: string
  barDim: string
  loop: string
  loopWeak: string
  faint: string
  line: string
  ink: string
}

/**
 * 파형 + A-B 구간 선택 + 확대/축소.
 *
 * 캔버스를 두 겹으로 나눈다: 파형·저장 구간·눈금은 정적 레이어(데이터나 보이는 범위가
 * 바뀔 때만), 선택 구간과 재생 헤드는 오버레이 레이어(rAF로 매 프레임). 4분 곡 파형을
 * 60fps로 다시 그릴 이유가 없다.
 *
 * 조작(Logic Pro처럼):
 * - 위쪽 시간 눈금 띠 드래그 → A-B 구간 선택. A·B 경계선은 위아래 어디서든 잡아 조정
 * - 파형 영역 드래그 → 좌우 이동, 클릭 → 그 위치로 이동
 * - 휠 위아래 · 트랙패드 핀치 → 마우스 위치를 기준으로 확대/축소
 * - 트랙패드 좌우 스와이프 · Shift+휠 → 좌우 이동
 * - 확대한 채 재생하면 재생 헤드가 화면 밖으로 나갈 때 화면이 따라간다.
 *   직접 다른 곳으로 옮겨 보고 있을 때는 끌어오지 않는다(헤드가 다시 화면에 들어오면 재개)
 */
export function Waveform() {
  const buffer = usePlayer((s) => s.buffer)
  const levels = usePlayer((s) => s.levels)
  const regions = usePlayer((s) => s.regions)
  const selection = usePlayer((s) => s.selection)
  const loopEnabled = usePlayer((s) => s.loopEnabled)
  const setSelection = usePlayer((s) => s.setSelection)
  const seek = usePlayer((s) => s.seek)

  const wrapRef = useRef<HTMLDivElement>(null)
  const baseRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const colorsRef = useRef<Colors | null>(null)

  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hoverSec, setHoverSec] = useState<number | null>(null)
  const [cursor, setCursor] = useState('default')
  /** 지난 프레임에 재생 헤드가 화면 안에 있었나 — 화면 따라가기 판단용 */
  const headWasInViewRef = useRef(true)

  const duration = buffer?.duration ?? 0

  /* ---------- 보이는 범위 ---------- */
  const [view, setView] = useState<View>({ start: 0, span: duration })
  // 곡이 바뀌면 전체 보기로
  useEffect(() => setView({ start: 0, span: duration }), [buffer, duration])
  const zoomed = duration > 0 && view.span > 0 && view.span < duration - 1e-6

  // 네이티브 휠 리스너와 rAF 루프는 최신 값을 ref로 읽는다
  const viewRef = useRef(view)
  viewRef.current = view
  const durationRef = useRef(duration)
  durationRef.current = duration

  /**
   * 휠. React의 onWheel은 passive라 preventDefault가 안 먹어서 페이지가 같이 스크롤된다.
   * 노드에 직접 { passive: false }로 붙인다.
   */
  const onWheel = useCallback((e: WheelEvent) => {
    const dur = durationRef.current
    const el = wrapRef.current
    if (!dur || !el) return
    e.preventDefault()

    const r = el.getBoundingClientRect()
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.width : 1
    const dx = e.deltaX * unit
    const dy = e.deltaY * unit
    const v = viewRef.current

    // 좌우 이동: 트랙패드 가로 스와이프, 또는 Shift+휠(브라우저에 따라 deltaY로 온다)
    if (!e.ctrlKey && (e.shiftKey || Math.abs(dx) > Math.abs(dy))) {
      const d = dx !== 0 ? dx : dy
      setView(clampView(v.start + (d / r.width) * v.span, v.span, dur))
      return
    }

    // 확대/축소: 마우스 아래 시점이 제자리에 남게. 핀치는 ctrlKey가 붙어 온다
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
    const anchor = v.start + ratio * v.span
    const span = v.span * Math.exp(dy * (e.ctrlKey ? PINCH_ZOOM_PER_PX : ZOOM_PER_PX))
    const next = clampView(0, span, dur)
    setView(clampView(anchor - ratio * next.span, next.span, dur))
  }, [])

  /* ---------- 크기 추적 ---------- */
  /**
   * 곡이 없을 때는 이 컴포넌트가 .wave-empty를 반환하므로 .wave-wrap이 아예 없다.
   * useEffect([])로 잡으면 첫 마운트에 ref가 null이라 관측을 놓치고, 곡을 열어도
   * 다시 돌지 않아 캔버스가 0×0으로 남는다. 노드가 붙는 순간 잡도록 콜백 ref를 쓴다.
   */
  const roRef = useRef<ResizeObserver | null>(null)
  const attachWrap = useCallback((el: HTMLDivElement | null) => {
    wrapRef.current?.removeEventListener('wheel', onWheel)
    wrapRef.current = el
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    roRef.current = ro
    measure()
  }, [onWheel])

  const readColors = useCallback((): Colors => {
    const el = wrapRef.current
    const cs = el ? getComputedStyle(el) : null
    const v = (name: string, fallback: string) => cs?.getPropertyValue(name).trim() || fallback
    return {
      bar: v('--accent', '#0B7C6E'),
      barDim: v('--accent-weak', 'rgba(11,124,110,.10)'),
      loop: v('--loop', '#C0741B'),
      loopWeak: v('--loop-weak', 'rgba(217,140,52,.16)'),
      faint: v('--faint', '#7C8987'),
      line: v('--line', '#E0E5E2'),
      ink: v('--ink', '#14181A'),
    }
  }, [])

  /* ---------- 정적 레이어: 파형 · 저장된 구간 · 눈금 ---------- */
  useEffect(() => {
    const canvas = baseRef.current
    if (!canvas || size.w === 0 || size.h === 0) return
    const dpr = window.devicePixelRatio || 1
    // 확대할 때마다 다시 그리므로, 크기가 그대로면 백킹 스토어를 새로 잡지 않는다
    if (canvas.width !== size.w * dpr) canvas.width = size.w * dpr
    if (canvas.height !== size.h * dpr) canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    const colors = readColors()
    colorsRef.current = colors

    const waveTop = RULER_H
    const waveH = size.h - RULER_H
    const mid = waveTop + waveH / 2
    const { start, span } = view
    const xOf = (sec: number) => ((sec - start) / span) * size.w

    // 저장된 구간 밴드 — 파형 아래에 깔린다
    if (duration > 0 && span > 0) {
      for (const r of regions) {
        const x1 = xOf(r.startSec)
        const x2 = xOf(r.endSec)
        if (x2 < 0 || x1 > size.w) continue
        ctx.fillStyle = colors.loopWeak
        ctx.fillRect(x1, waveTop, Math.max(1, x2 - x1), waveH)
      }
    }

    // 파형 — 픽셀 열마다 그 열이 덮는 프레임 범위를 실제로 모은다(어느 배율에서든 계단이 없다).
    // peak는 옅게, rms(체감 음량)는 진하게 겹친다 — 크게 마스터링된 곡은 peak가 거의 전 구간
    // 최대라 구분은 rms 층이 맡는다. 열 경계는 곡의 시간 격자에 고정돼 좌우 이동 때 흔들리지
    // 않는다(columnLevels). 위아래로 여유를 둬서 손잡이·A/B 라벨과 겹치지 않게 한다.
    if (levels && span > 0) {
      const amp = (waveH / 2) * 0.85
      const cols = columnLevels(levels, start, span, size.w)
      ctx.fillStyle = colors.bar
      for (let x = 0; x < size.w; x++) {
        const hp = Math.max(1, cols.peak[x] * amp)
        const hr = Math.max(1, cols.rms[x] * amp)
        ctx.globalAlpha = 0.22
        ctx.fillRect(x, mid - hp, 1, hp * 2)
        ctx.globalAlpha = 0.85
        ctx.fillRect(x, mid - hr, 1, hr * 2)
      }
      ctx.globalAlpha = 1
    }

    // 중심선
    ctx.fillStyle = colors.line
    ctx.fillRect(0, mid, size.w, 1)

    // 눈금 띠 — 파형과 구분되게 옅은 바탕과 아래 경계선
    ctx.fillStyle = colors.faint
    ctx.globalAlpha = 0.07
    ctx.fillRect(0, 0, size.w, RULER_H)
    ctx.globalAlpha = 1
    ctx.fillStyle = colors.line
    ctx.fillRect(0, RULER_H - 1, size.w, 1)

    // 눈금 — 보이는 범위에 따라 0.1초~5분 간격
    if (duration > 0 && span > 0) {
      const targetTicks = Math.max(4, Math.floor(size.w / 90))
      const step = TICK_STEPS.find((s) => span / s <= targetTicks) ?? 600
      ctx.fillStyle = colors.faint
      ctx.font = '10px ui-monospace, Menlo, monospace'
      ctx.textBaseline = 'top'
      // 부동소수 누적을 피하려고 정수 k로 센다
      for (let k = Math.ceil(start / step - 1e-9); k * step <= start + span; k++) {
        const t = k * step
        const x = xOf(t)
        ctx.fillRect(x, RULER_H - 5, 1, 5)
        const label = step < 1 ? formatTime(t) : formatTime(t).replace(/\.\d$/, '')
        if (x < size.w - 40) ctx.fillText(label, x + 3, 4)
      }
    }

    // 확대 중이면 맨 아래에 곡 전체 중 지금 보는 위치를 얇은 막대로
    if (zoomed) {
      ctx.fillStyle = colors.faint
      ctx.globalAlpha = 0.18
      ctx.fillRect(0, size.h - 3, size.w, 3)
      ctx.globalAlpha = 0.7
      ctx.fillStyle = colors.bar
      ctx.fillRect((start / duration) * size.w, size.h - 3, Math.max(4, (span / duration) * size.w), 3)
      ctx.globalAlpha = 1
    }
  }, [size, levels, regions, duration, view, zoomed, readColors])

  /* ---------- 오버레이 레이어: 선택 구간 + 재생 헤드 ---------- */
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || size.w === 0 || size.h === 0) return
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== size.w * dpr) canvas.width = size.w * dpr
    if (canvas.height !== size.h * dpr) canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const { start, span } = view
    let raf = 0
    const draw = () => {
      const colors = colorsRef.current ?? readColors()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.w, size.h)

      const waveTop = RULER_H
      const waveH = size.h - RULER_H

      if (duration > 0 && span > 0) {
        const xOf = (sec: number) => ((sec - start) / span) * size.w

        // 선택 구간 A-B
        if (selection) {
          const x1 = xOf(selection.startSec)
          const x2 = xOf(selection.endSec)
          ctx.fillStyle = colors.loopWeak
          ctx.fillRect(x1, waveTop, Math.max(1, x2 - x1), waveH)

          ctx.fillStyle = colors.loop
          ctx.globalAlpha = loopEnabled ? 1 : 0.45
          ctx.fillRect(x1 - 1, 0, 2, size.h)
          ctx.fillRect(x2 - 1, 0, 2, size.h)
          // 눈금 띠 위의 사이클 바 — 구간이 눈금에서 잡힌다는 걸 보여 준다
          ctx.globalAlpha = loopEnabled ? 0.32 : 0.15
          ctx.fillRect(x1, RULER_H - 9, Math.max(1, x2 - x1), 8)
          ctx.globalAlpha = loopEnabled ? 1 : 0.45
          // 잡기 쉬운 손잡이
          ctx.fillRect(x1 - 4, RULER_H - 10, 8, 10)
          ctx.fillRect(x2 - 4, RULER_H - 10, 8, 10)
          ctx.globalAlpha = 1

          ctx.font = '10px ui-monospace, Menlo, monospace'
          ctx.fillStyle = colors.loop
          ctx.textBaseline = 'bottom'
          ctx.fillText(`A ${formatTime(selection.startSec)}`, Math.min(x1 + 6, size.w - 70), size.h - 4)
          const bLabel = `B ${formatTime(selection.endSec)}`
          ctx.fillText(bLabel, Math.max(4, Math.min(x2 + 6, size.w - 62)), size.h - 16)
        }

        // 재생 헤드
        const pos = engine.getPositionSec()

        // 확대한 채 재생 중에 헤드가 화면 안에 있다가 밖으로 나가면 화면이 따라간다
        // (헤드를 왼쪽 5%에). 처음부터 밖에 있었다면 = 사용자가 다른 곳을 보고 있다면 두고,
        // 드래그 중에도 손 아래 좌표가 바뀌면 안 되니 움직이지 않는다.
        const inView = pos >= start && pos <= start + span
        if (
          !inView && headWasInViewRef.current && span < duration - 1e-6 &&
          !dragRef.current && usePlayer.getState().isPlaying
        ) {
          setView(clampView(pos - span * 0.05, span, duration))
          return // 새 view로 effect가 다시 돌며 루프를 이어받는다
        }
        headWasInViewRef.current = inView

        // 기기 픽셀에 맞춰 그린다 — 소수 위치면 안티에일리어싱으로 두께가 매 프레임 달라져 반짝인다
        const px = Math.round(xOf(pos) * dpr) / dpr
        ctx.fillStyle = colors.ink
        ctx.fillRect(px - 1, waveTop, 2, waveH)

        // 마우스 위치 안내선
        if (hoverSec !== null && !dragRef.current) {
          const hx = xOf(hoverSec)
          ctx.fillStyle = colors.faint
          ctx.globalAlpha = 0.5
          ctx.fillRect(hx, waveTop, 1, waveH)
          ctx.globalAlpha = 1
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size, duration, view, selection, loopEnabled, hoverSec, readColors])

  /* ---------- 포인터 조작 ---------- */

  const secFromClientX = useCallback(
    (clientX: number) => {
      const el = wrapRef.current
      if (!el || duration === 0) return 0
      const r = el.getBoundingClientRect()
      const ratio = (clientX - r.left) / r.width
      return Math.max(0, Math.min(duration, view.start + ratio * view.span))
    },
    [duration, view],
  )

  /** 포인터 위치에서 무엇을 하게 될지 — 누를 때와 커서 모양이 같은 판단을 쓴다 */
  const modeAt = (x: number, y: number, width: number): DragMode => {
    if (selection) {
      const xs = ((selection.startSec - view.start) / view.span) * width
      const xe = ((selection.endSec - view.start) / view.span) * width
      if (Math.abs(x - xs) <= HANDLE_HIT_PX) return 'start'
      if (Math.abs(x - xe) <= HANDLE_HIT_PX) return 'end'
    }
    return y < RULER_H ? 'new' : 'pan'
  }

  const cursorFor = (mode: DragMode, dragging: boolean) =>
    mode === 'start' || mode === 'end'
      ? 'ew-resize'
      : mode === 'new'
        ? 'crosshair'
        : zoomed
          ? dragging ? 'grabbing' : 'grab'
          : 'default'

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration === 0) return
    const el = wrapRef.current!
    const r = el.getBoundingClientRect()
    const x = e.clientX - r.left
    const mode = modeAt(x, e.clientY - r.top, r.width)

    dragRef.current = { mode, anchorSec: secFromClientX(e.clientX), startX: x, startView: view, moved: false }
    setCursor(cursorFor(mode, true))
    el.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration === 0) return
    const el = wrapRef.current!
    const r = el.getBoundingClientRect()
    const x = e.clientX - r.left
    const drag = dragRef.current
    if (!drag) {
      setHoverSec(secFromClientX(e.clientX))
      setCursor(cursorFor(modeAt(x, e.clientY - r.top, r.width), false))
      return
    }

    if (!drag.moved && Math.abs(x - drag.startX) > DRAG_THRESHOLD_PX) drag.moved = true
    if (!drag.moved) return

    if (drag.mode === 'pan') {
      // 잡은 지점이 손을 따라오게: 오른쪽으로 끌면 앞부분이 보인다
      const v = drag.startView
      setView(clampView(v.start - ((x - drag.startX) / r.width) * v.span, v.span, duration))
      return
    }

    const sec = secFromClientX(e.clientX)
    if (drag.mode === 'new') {
      const a = Math.min(drag.anchorSec, sec)
      const b = Math.max(drag.anchorSec, sec)
      if (b - a >= MIN_SELECTION_SEC) setSelection({ startSec: a, endSec: b }, false)
    } else if (drag.mode === 'start' && selection) {
      const startSec = Math.min(sec, selection.endSec - MIN_SELECTION_SEC)
      setSelection({ startSec: Math.max(0, startSec), endSec: selection.endSec }, false)
    } else if (drag.mode === 'end' && selection) {
      const endSec = Math.max(sec, selection.startSec + MIN_SELECTION_SEC)
      setSelection({ startSec: selection.startSec, endSec: Math.min(duration, endSec) }, false)
    }
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    wrapRef.current?.releasePointerCapture(e.pointerId)
    if (!drag) return
    setCursor(cursorFor(drag.mode, false))
    if (!drag.moved) {
      // 끌지 않았으면 클릭 = 이동(눈금이든 파형이든). 기존 선택은 그대로 둔다
      seek(drag.anchorSec)
      return
    }
    if (drag.mode === 'pan') return
    // 손을 뗄 때 한 번만 엔진에 반영한다
    const final = usePlayer.getState().selection
    if (final) setSelection(final, true)
  }

  if (!buffer) {
    return (
      <div className="wave-empty">
        <p>왼쪽에서 곡을 고르거나, mp3 파일을 이 영역에 끌어다 놓으세요.</p>
      </div>
    )
  }

  return (
    <div
      ref={attachWrap}
      className="wave-wrap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => setHoverSec(null)}
      style={{ cursor }}
      role="slider"
      aria-label="파형 — 위쪽 눈금을 드래그해 A-B 구간 선택, 파형 드래그로 좌우 이동, 휠로 확대/축소"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={selection?.startSec ?? 0}
      tabIndex={0}
      data-view-start={view.start.toFixed(3)}
      data-view-span={view.span.toFixed(3)}
    >
      {/* 표시 크기는 CSS가 100%로 잡고, 여기서는 백킹 스토어 해상도만 size로 맞춘다 */}
      <canvas ref={baseRef} />
      <canvas ref={overlayRef} />
      {zoomed && (
        <button
          type="button"
          className="wave-fit"
          // 파형의 드래그·클릭 이동이 같이 일어나지 않게
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setView({ start: 0, span: duration })}
          title="곡 전체 보기"
        >
          전체 보기 · {(duration / view.span).toFixed(view.span > duration / 10 ? 1 : 0)}×
        </button>
      )}
    </div>
  )
}
