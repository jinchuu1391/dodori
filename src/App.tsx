import { useEffect, useState } from 'react'
import { Library } from './components/Library'
import { Transport } from './components/Transport'
import { Stage } from './components/Stage'
import { DrillPanel } from './components/DrillPanel'
import { RegionList } from './components/RegionList'
import { usePlayer } from './store/usePlayer'

export default function App() {
  const init = usePlayer((s) => s.init)
  const openFiles = usePlayer((s) => s.openFiles)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const loopEnabled = usePlayer((s) => s.loopEnabled)
  const setLoopEnabled = usePlayer((s) => s.setLoopEnabled)
  const status = usePlayer((s) => s.status)
  const error = usePlayer((s) => s.error)
  const undoLabel = usePlayer((s) => s.undoLabel)
  const redoLabel = usePlayer((s) => s.redoLabel)
  const historyLocked = usePlayer((s) => s.historyBusy || s.beatEditing)
  const undo = usePlayer((s) => s.undo)
  const redo = usePlayer((s) => s.redo)
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  // 단축키 — 연습 중에 마우스를 옮기지 않으려고
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && usePlayer.getState().beatEditing) {
        e.preventDefault()
        usePlayer.getState().cancelBeatEditing()
        return
      }
      const t = e.target instanceof HTMLElement ? e.target : null
      if (t?.matches('textarea, input:not([type="range"]):not([type="checkbox"]), select') || t?.isContentEditable) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const key = e.key.toLowerCase()
        if (key === 'z' || key === 'y') {
          e.preventDefault()
          if (!e.repeat) void (key === 'y' || e.shiftKey ? redo() : undo())
        }
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        void togglePlay()
      } else if (e.key === 'l' || e.key === 'L') {
        setLoopEnabled(!loopEnabled)
      } else if (e.key === 't' || e.key === 'T') {
        usePlayer.getState().markBeat()
      } else if (e.key === 'm' || e.key === 'M') {
        const s = usePlayer.getState()
        s.setMetronomeOn(!s.metronomeOn)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, loopEnabled, setLoopEnabled, undo, redo])

  return (
    <div
      className={`app${dragOver ? ' drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        if (e.dataTransfer.files.length) void openFiles(e.dataTransfer.files)
      }}
    >
      <header className="topbar">
        <h1>
          도돌이 <span className="en">dodori</span>
        </h1>
        <span className="ver">M1 · 로컬 전용</span>
        <a className="src-link" href="https://github.com/jinchuu1391/dodori" target="_blank" rel="noreferrer" title="소스 코드 (AGPL-3.0)">
          소스 · AGPL-3.0
        </a>
        <div className="history-controls" role="group" aria-label="변경 기록">
          <button type="button" disabled={historyLocked || !undoLabel} onClick={() => void undo()}
            title={undoLabel ? `${undoLabel} 실행 취소` : '실행 취소할 변경 없음'}
            onKeyDown={(e) => { if (e.code === 'Space') e.stopPropagation() }}>
            실행 취소
          </button>
          <button type="button" disabled={historyLocked || !redoLabel} onClick={() => void redo()}
            title={redoLabel ? `${redoLabel} 다시 실행` : '다시 실행할 변경 없음'}
            onKeyDown={(e) => { if (e.code === 'Space') e.stopPropagation() }}>
            다시 실행
          </button>
        </div>
        {status && <span className="status">{status}</span>}
        {error && <span className="err">{error}</span>}
      </header>

      <div className="body">
        <Library />
        <main className="player">
          <Transport />
          <Stage />
          <DrillPanel />
          <RegionList />
        </main>
      </div>

      {dragOver && <div className="dropzone">여기에 놓으면 추가됩니다</div>}
    </div>
  )
}
