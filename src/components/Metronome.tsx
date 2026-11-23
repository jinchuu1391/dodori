import { useEffect, useState } from 'react'
import { BPM_MAX, BPM_MIN, usePlayer } from '../store/usePlayer'

const BEATS_PER_BAR = [2, 3, 4, 6]
/** 이보다 느리면 SoundTouch가 음악을 앞뒤로 밀어서 클릭이 수십 ms 어긋날 수 있다(측정값) */
const ACCURATE_SPEED_MIN = 0.75
/** 첫 박 미세 조정 — 기본 10ms, Shift를 누르면 1ms */
const NUDGE_SEC = 0.01
const NUDGE_FINE_SEC = 0.001
/** 자동 감지 신뢰도(Essentia multifeature)가 이보다 낮으면 결과를 확인해 보라고 알린다 */
const LOW_CONFIDENCE = 1

/** 5.3149 → "0:05.315" — 첫 박은 ms 단위까지 보여야 맞추는 감이 온다 */
function formatMs(sec: number): string {
  const s = Math.max(0, sec)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(3).padStart(6, '0')}`
}

/**
 * 메트로놈 — 켜기 · 자동 감지 · 첫 박 찍기 · 첫 박 미세 조정 · BPM · 박자 · 클릭 음량.
 *
 * 0) "자동"을 누르면 고른 구간(없으면 곡 전체)을 분석해 BPM과 첫 박을 채운다.
 *    빠르기가 두 배·절반으로 잡히면 ×2 · ÷2, 강박 위치가 다르면 "강박 →"로 고친다
 * 1) 또는 재생하며 박이 오는 순간 "첫 박"(T)을 한 번 누른다 — 그 위치가 1박
 * 2) BPM을 −/+ 로 맞춘다. 첫 박은 고정이라 뒤쪽 박들만 벌어지거나 좁혀진다
 * 3) 첫 박이 살짝 어긋나면 ◀ ▶ 로 10ms(Shift 1ms)씩, 또는 파형에서 박자 선을 끌어 맞춘다
 */
export function Metronome() {
  const buffer = usePlayer((s) => s.buffer)
  const grid = usePlayer((s) => s.beatGrid)
  const editing = usePlayer((s) => s.beatEditing)
  const setEditing = usePlayer((s) => s.setBeatEditing)
  const cancelEditing = usePlayer((s) => s.cancelBeatEditing)
  const canEditGrid = editing && grid !== null
  const on = usePlayer((s) => s.metronomeOn)
  const volume = usePlayer((s) => s.metronomeVolume)
  const speed = usePlayer((s) => s.speed)
  const setOn = usePlayer((s) => s.setMetronomeOn)
  const setVolume = usePlayer((s) => s.setMetronomeVolume)
  const setGrid = usePlayer((s) => s.setBeatGrid)
  const markBeat = usePlayer((s) => s.markBeat)
  const autoDetect = usePlayer((s) => s.autoDetectBeat)
  const detecting = usePlayer((s) => s.beatDetecting)
  const confidence = usePlayer((s) => s.beatConfidence)

  // 입력 중에는 글자 그대로 두고, Enter·포커스 아웃 때 반영한다
  const [bpmText, setBpmText] = useState('')
  useEffect(() => setBpmText(grid ? String(grid.bpm) : ''), [grid, editing])

  const setBpm = (v: number) => {
    if (!editing || !grid || !Number.isFinite(v)) return
    const bpm = Math.round(Math.min(BPM_MAX, Math.max(BPM_MIN, v)) * 10) / 10
    if (bpm !== grid.bpm) setGrid({ ...grid, bpm })
    else setBpmText(String(grid.bpm))
  }

  /** ×2 · ÷2 — 반올림하지 않는다(자동 감지 BPM의 소수 자리가 곡 끝까지의 정확도를 좌우한다) */
  const scaleBpm = (f: number) => {
    if (!grid) return
    const bpm = grid.bpm * f
    if (bpm >= BPM_MIN && bpm <= BPM_MAX) setGrid({ ...grid, bpm })
  }

  /** 강박을 다음 박으로 — 첫 박을 한 박 뒤로 옮긴다(박 위치는 그대로) */
  const shiftDownbeat = () => {
    if (!grid) return
    setGrid({ ...grid, anchorSec: Math.round((grid.anchorSec + 60 / grid.bpm) * 10000) / 10000 })
  }

  const nudge = (dir: 1 | -1, fine: boolean) => {
    if (!grid) return
    const anchorSec = Math.round((grid.anchorSec + dir * (fine ? NUDGE_FINE_SEC : NUDGE_SEC)) * 10000) / 10000
    setGrid({ ...grid, anchorSec })
  }

  return (
    <div className="drill-row metro">
      <label className="toggle">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} disabled={!buffer} />
        <span>메트로놈</span>
      </label>

      <button
        type="button"
        className="metro-mark metro-edit"
        aria-pressed={editing}
        onKeyDown={(e) => { if (e.code === 'Space') e.stopPropagation() }}
        onClick={() => setEditing(!editing)}
        disabled={!buffer}
      >
        {editing ? '박자 편집 완료' : '박자 편집'}
      </button>
      {editing && (
        <button
          type="button"
          className="metro-mark"
          onKeyDown={(e) => { if (e.code === 'Space') e.stopPropagation() }}
          onClick={cancelEditing}
        >
          편집 취소
        </button>
      )}

      <button
        type="button"
        className="metro-mark"
        onClick={() => void autoDetect()}
        disabled={!editing || !buffer || detecting}
        title="고른 구간(없으면 곡 전체)에서 BPM과 첫 박을 자동으로 찾습니다"
      >
        {detecting ? '분석 중…' : '자동'}
      </button>

      <button
        type="button"
        className="metro-mark"
        onClick={markBeat}
        disabled={!editing || !buffer}
        title="지금 위치를 1박으로 (단축키 T) — 재생하며 박이 오는 순간 누르세요"
      >
        첫 박 찍기
      </button>

      <span className="metro-anchor" aria-label="첫 박 위치">
        <button
          type="button"
          onClick={(e) => nudge(-1, e.shiftKey)}
          disabled={!canEditGrid}
          title="첫 박을 10ms 앞으로 (Shift: 1ms)"
          aria-label="첫 박 앞으로"
        >
          ◀
        </button>
        <span className="metro-anchor-time">{grid ? formatMs(grid.anchorSec) : '–:––.–––'}</span>
        <button
          type="button"
          onClick={(e) => nudge(1, e.shiftKey)}
          disabled={!canEditGrid}
          title="첫 박을 10ms 뒤로 (Shift: 1ms)"
          aria-label="첫 박 뒤로"
        >
          ▶
        </button>
        <button
          type="button"
          className="metro-wide"
          onClick={shiftDownbeat}
          disabled={!canEditGrid}
          title="강박(1박)을 다음 박으로 옮깁니다"
        >
          강박 →
        </button>
      </span>

      <span className="metro-bpm">
        <button type="button" onClick={() => grid && setBpm(grid.bpm - 1)} disabled={!canEditGrid} aria-label="BPM 1 내리기">
          −
        </button>
        <input
          type="number"
          inputMode="decimal"
          min={BPM_MIN}
          max={BPM_MAX}
          step={0.1}
          placeholder="BPM"
          value={bpmText}
          onChange={(e) => setBpmText(e.target.value)}
          onBlur={() => setBpm(Number(bpmText))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          disabled={!canEditGrid}
          aria-label="BPM"
        />
        <button type="button" onClick={() => grid && setBpm(grid.bpm + 1)} disabled={!canEditGrid} aria-label="BPM 1 올리기">
          +
        </button>
        <span className="unit">BPM</span>
        <button
          type="button"
          className="metro-wide"
          onClick={() => scaleBpm(0.5)}
          disabled={!canEditGrid || !grid || grid.bpm / 2 < BPM_MIN}
          title="빠르기를 절반으로"
        >
          ÷2
        </button>
        <button
          type="button"
          className="metro-wide"
          onClick={() => scaleBpm(2)}
          disabled={!canEditGrid || !grid || grid.bpm * 2 > BPM_MAX}
          title="빠르기를 두 배로"
        >
          ×2
        </button>
      </span>

      <select
        className="metro-bar"
        value={grid?.beatsPerBar ?? 4}
        onChange={(e) => grid && setGrid({ ...grid, beatsPerBar: Number(e.target.value) })}
        disabled={!canEditGrid}
        aria-label="한 마디 박 수"
      >
        {BEATS_PER_BAR.map((b) => (
          <option key={b} value={b}>
            {b}/4
          </option>
        ))}
      </select>

      <label className="metro-vol" title="클릭 음량">
        <span>클릭</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label="클릭 음량"
        />
      </label>

      <span className="hint">
        {!editing
          ? 'BPM이나 첫 박을 바꾸려면 박자 편집을 켜세요'
          : !grid
            ? '"자동"으로 찾거나, 재생하며 박이 오는 순간 "첫 박 찍기"(T)를 누르세요'
            : confidence !== null && confidence < LOW_CONFIDENCE
              ? '자동 감지 결과가 불확실해요. 들어 보고 BPM·첫 박을 고쳐 주세요'
              : on && speed < ACCURATE_SPEED_MIN
                ? '느린 속도에서는 클릭이 음악과 조금 어긋날 수 있어요'
                : 'BPM을 맞춘 뒤, 첫 박은 ◀ ▶ 나 파형의 박자 선을 끌어 맞추세요'}
      </span>
    </div>
  )
}
