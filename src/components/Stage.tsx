import { useRef, useState } from 'react'
import { Waveform } from './Waveform'

const HEIGHT_KEY = 'dodori:stageHeight'
const DEFAULT_HEIGHT = 240
const MIN_HEIGHT = 120
/** 아래 구간 패널·북마크가 최소한은 보이도록 남겨 둘 높이 */
const RESERVED_BELOW = 220

function maxHeight() {
  return Math.max(MIN_HEIGHT, window.innerHeight - RESERVED_BELOW)
}

function clampHeight(h: number) {
  return Math.round(Math.max(MIN_HEIGHT, Math.min(maxHeight(), h)))
}

function loadHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY))
    if (Number.isFinite(v) && v > 0) return clampHeight(v)
  } catch {
    /* 저장소를 못 쓰는 환경 — 기본값 */
  }
  return DEFAULT_HEIGHT
}

function saveHeight(h: number) {
  try {
    localStorage.setItem(HEIGHT_KEY, String(h))
  } catch {
    /* 저장 못 해도 이번 세션에서는 그대로 동작 */
  }
}

/**
 * 파형 영역 + 아래 끝 높이 조절 손잡이.
 * 손잡이를 위아래로 끌면 높이가 바뀌고, 더블클릭하면 기본 높이로 돌아간다.
 * 높이는 이 브라우저에 기억한다.
 */
export function Stage() {
  const [height, setHeight] = useState(loadHeight)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    if (!d) return
    setHeight(clampHeight(d.startH + e.clientY - d.startY))
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    setDragging(false)
    e.currentTarget.releasePointerCapture(e.pointerId)
    saveHeight(height)
  }

  return (
    <div className={`stage-box${dragging ? ' resizing' : ''}`}>
      <div className="stage" style={{ height }}>
        <Waveform />
      </div>
      <div
        className="stage-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="파형 영역 높이 조절"
        aria-valuenow={height}
        aria-valuemin={MIN_HEIGHT}
        title="끌어서 높이 조절 · 더블클릭하면 기본 높이"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          setHeight(clampHeight(DEFAULT_HEIGHT))
          saveHeight(DEFAULT_HEIGHT)
        }}
      />
    </div>
  )
}
