import { useEffect, useState } from 'react'
import { Library } from './components/Library'
import { Transport } from './components/Transport'
import { Waveform } from './components/Waveform'
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
  const [dragOver, setDragOver] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  // 단축키 — 연습 중에 마우스를 옮기지 않으려고
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (e.code === 'Space') {
        e.preventDefault()
        void togglePlay()
      } else if (e.key === 'l' || e.key === 'L') {
        setLoopEnabled(!loopEnabled)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, loopEnabled, setLoopEnabled])

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
        {status && <span className="status">{status}</span>}
        {error && <span className="err">{error}</span>}
      </header>

      <div className="body">
        <Library />
        <main className="player">
          <Transport />
          <div className="stage">
            <Waveform />
          </div>
          <DrillPanel />
          <RegionList />
        </main>
      </div>

      {dragOver && <div className="dropzone">여기에 놓으면 추가됩니다</div>}
    </div>
  )
}
