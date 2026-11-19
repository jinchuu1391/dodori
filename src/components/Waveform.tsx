import { useCallback, useEffect, useRef, useState } from 'react'
import { engine } from '../audio/engine'
import { usePlayer } from '../store/usePlayer'
import { formatTime } from '../util/time'

const HANDLE_HIT_PX = 9
const DRAG_THRESHOLD_PX = 3
const MIN_SELECTION_SEC = 0.05

type DragMode = 'new' | 'start' | 'end'
interface DragState {
  mode: DragMode
  anchorSec: number
  startX: number
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
 * 파형 + A-B 구간 선택.
 *
 * 캔버스를 두 겹으로 나눈다: 파형·저장 구간·눈금은 정적 레이어(데이터 바뀔 때만),
 * 선택 구간과 재생 헤드는 오버레이 레이어(rAF로 매 프레임). 4분 곡 파형을 60fps로
 * 다시 그릴 이유가 없다.
 */
export function Waveform() {
  const buffer = usePlayer((s) => s.buffer)
  const peaks = usePlayer((s) => s.peaks)
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

  const duration = buffer?.duration ?? 0

  /* ---------- 크기 추적 ---------- */
  /**
   * 곡이 없을 때는 이 컴포넌트가 .wave-empty를 반환하므로 .wave-wrap이 아예 없다.
   * useEffect([])로 잡으면 첫 마운트에 ref가 null이라 관측을 놓치고, 곡을 열어도
   * 다시 돌지 않아 캔버스가 0×0으로 남는다. 노드가 붙는 순간 잡도록 콜백 ref를 쓴다.
   */
  const roRef = useRef<ResizeObserver | null>(null)
  const attachWrap = useCallback((el: HTMLDivElement | null) => {
    wrapRef.current = el
    roRef.current?.disconnect()
    roRef.current = null
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.round(r.width), h: Math.round(r.height) })
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    roRef.current = ro
    measure()
  }, [])

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
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, size.w, size.h)

    const colors = readColors()
    colorsRef.current = colors

    const rulerH = 18
    const waveTop = rulerH
    const waveH = size.h - rulerH
    const mid = waveTop + waveH / 2

    // 저장된 구간 밴드 — 파형 아래에 깔린다
    if (duration > 0) {
      for (const r of regions) {
        const x1 = (r.startSec / duration) * size.w
        const x2 = (r.endSec / duration) * size.w
        ctx.fillStyle = colors.loopWeak
        ctx.fillRect(x1, waveTop, Math.max(1, x2 - x1), waveH)
      }
    }

    // 파형 — 픽셀 열마다 해당 버킷의 피크를 대칭으로
    if (peaks && peaks.length > 0) {
      ctx.fillStyle = colors.bar
      ctx.globalAlpha = 0.6
      for (let x = 0; x < size.w; x++) {
        const i = Math.min(peaks.length - 1, Math.floor((x / size.w) * peaks.length))
        const h = Math.max(1, peaks[i] * (waveH / 2 - 2))
        ctx.fillRect(x, mid - h, 1, h * 2)
      }
      ctx.globalAlpha = 1
    }

    // 중심선
    ctx.fillStyle = colors.line
    ctx.fillRect(0, mid, size.w, 1)

    // 눈금 — 화면 너비에 따라 5/10/15/30/60초 간격
    if (duration > 0) {
      const targetTicks = Math.max(4, Math.floor(size.w / 90))
      const steps = [1, 2, 5, 10, 15, 30, 60, 120]
      const step = steps.find((s) => duration / s <= targetTicks) ?? 300
      ctx.fillStyle = colors.faint
      ctx.font = '10px ui-monospace, Menlo, monospace'
      ctx.textBaseline = 'top'
      for (let t = 0; t <= duration; t += step) {
        const x = (t / duration) * size.w
        ctx.fillRect(x, rulerH - 5, 1, 5)
        if (x < size.w - 26) ctx.fillText(formatTime(t).replace(/\.\d$/, ''), x + 3, 2)
      }
    }
  }, [size, peaks, regions, duration, readColors])

  /* ---------- 오버레이 레이어: 선택 구간 + 재생 헤드 ---------- */
  useEffect(() => {
    const canvas = overlayRef.current
    if (!canvas || size.w === 0 || size.h === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    const draw = () => {
      const colors = colorsRef.current ?? readColors()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.w, size.h)

      const rulerH = 18
      const waveTop = rulerH
      const waveH = size.h - rulerH

      if (duration > 0) {
        const xOf = (sec: number) => (sec / duration) * size.w

        // 선택 구간 A-B
        if (selection) {
          const x1 = xOf(selection.startSec)
          const x2 = xOf(selection.endSec)
          ctx.fillStyle = colors.loopWeak
          ctx.fillRect(x1, waveTop, Math.max(1, x2 - x1), waveH)

          ctx.fillStyle = colors.loop
          ctx.globalAlpha = loopEnabled ? 1 : 0.45
          ctx.fillRect(x1 - 1, waveTop, 2, waveH)
          ctx.fillRect(x2 - 1, waveTop, 2, waveH)
          // 잡기 쉬운 손잡이
          ctx.fillRect(x1 - 4, waveTop, 8, 9)
          ctx.fillRect(x2 - 4, waveTop, 8, 9)
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
        const px = xOf(pos)
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
  }, [size, duration, selection, loopEnabled, hoverSec, readColors])

  /* ---------- 포인터 조작 ---------- */

  const secFromClientX = useCallback(
    (clientX: number) => {
      const el = wrapRef.current
      if (!el || duration === 0) return 0
      const r = el.getBoundingClientRect()
      const ratio = (clientX - r.left) / r.width
      return Math.max(0, Math.min(duration, ratio * duration))
    },
    [duration],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration === 0) return
    const el = wrapRef.current!
    const r = el.getBoundingClientRect()
    const x = e.clientX - r.left
    const sec = secFromClientX(e.clientX)

    let mode: DragMode = 'new'
    if (selection) {
      const xs = (selection.startSec / duration) * r.width
      const xe = (selection.endSec / duration) * r.width
      if (Math.abs(x - xs) <= HANDLE_HIT_PX) mode = 'start'
      else if (Math.abs(x - xe) <= HANDLE_HIT_PX) mode = 'end'
    }

    dragRef.current = { mode, anchorSec: sec, startX: x, moved: false }
    el.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (duration === 0) return
    const sec = secFromClientX(e.clientX)
    const drag = dragRef.current
    if (!drag) {
      setHoverSec(sec)
      return
    }

    const el = wrapRef.current!
    const x = e.clientX - el.getBoundingClientRect().left
    if (!drag.moved && Math.abs(x - drag.startX) > DRAG_THRESHOLD_PX) drag.moved = true
    if (!drag.moved) return

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
    if (!drag.moved) {
      // 끌지 않았으면 클릭 = 이동. 기존 선택은 그대로 둔다
      seek(drag.anchorSec)
      return
    }
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
      role="slider"
      aria-label="파형 — 드래그로 A-B 구간 선택"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={selection?.startSec ?? 0}
      tabIndex={0}
    >
      {/* 표시 크기는 CSS가 100%로 잡고, 여기서는 백킹 스토어 해상도만 size로 맞춘다 */}
      <canvas ref={baseRef} />
      <canvas ref={overlayRef} />
    </div>
  )
}
