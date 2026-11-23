import { useState } from 'react'
import { usePlayer } from '../store/usePlayer'
import { formatTime } from '../util/time'
import { Metronome } from './Metronome'

/**
 * 드릴 패널 — 구간을 정하고 루프를 켜고, 메트로놈을 맞춘다.
 * 반복 횟수 · 반복 간격 · 점진적 속도 · 카운트인은 M2.
 */
export function DrillPanel() {
  const buffer = usePlayer((s) => s.buffer)
  const selection = usePlayer((s) => s.selection)
  const setSelection = usePlayer((s) => s.setSelection)
  const loopEnabled = usePlayer((s) => s.loopEnabled)
  const setLoopEnabled = usePlayer((s) => s.setLoopEnabled)
  const saveSelectionAsRegion = usePlayer((s) => s.saveSelectionAsRegion)
  const seek = usePlayer((s) => s.seek)
  // 저장된 북마크를 그대로 쓰는 중이면 저장할 게 없다. 경계를 끌어 바꾸면 activeRegionId가 비워진다
  const activeRegion = usePlayer((s) => s.regions.find((r) => r.id === s.activeRegionId) ?? null)
  const [label, setLabel] = useState('')

  const len = selection ? selection.endSec - selection.startSec : 0

  return (
    <div className="drill">
      <div className="drill-row">
        <span className="lbl">A-B 구간</span>
        {selection ? (
          <span className="ab">
            <button className="chip" onClick={() => seek(selection.startSec)} title="A로 이동">
              A {formatTime(selection.startSec)}
            </button>
            <span className="dash">—</span>
            <button className="chip" onClick={() => seek(selection.endSec)} title="B로 이동">
              B {formatTime(selection.endSec)}
            </button>
            <span className="len">{len.toFixed(1)}초</span>
            <button className="ghost" onClick={() => setSelection(null)}>
              해제
            </button>
            {activeRegion ? (
              <span className="ab-saved" title="저장된 구간 북마크">
                {activeRegion.label}
              </span>
            ) : (
              <form
                className="save-region"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!selection || !label.trim()) return
                  void saveSelectionAsRegion(label)
                  setLabel('')
                }}
              >
                <input
                  type="text"
                  aria-label="구간 이름"
                  placeholder="구간 이름 (예: 1절 고음)"
                  required
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
                <button type="submit" disabled={!label.trim()}>구간 저장</button>
              </form>
            )}
          </span>
        ) : (
          <span className="hint">위쪽 시간 눈금을 드래그해 구간을 잡으세요</span>
        )}
      </div>

      <div className="drill-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={loopEnabled}
            onChange={(e) => setLoopEnabled(e.target.checked)}
            disabled={!buffer}
          />
          <span>구간 반복</span>
        </label>
      </div>

      <Metronome />

      <p className="drill-note">
        반복 횟수 · 반복 간격 · 점진적 속도 · 카운트인은 <b>M2</b>에서 붙습니다.
      </p>
    </div>
  )
}
