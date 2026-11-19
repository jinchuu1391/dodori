import { useEffect, useState } from 'react'
import { engine } from '../audio/engine'

/**
 * 재생 위치를 rAF로 읽되, 0.05초 이상 움직였을 때만 리렌더한다.
 * 캔버스 헤드는 Waveform이 직접 그리므로 여기서는 시간 표시용으로만 쓴다.
 */
export function usePlayheadSec(): number {
  const [sec, setSec] = useState(0)
  useEffect(() => {
    let raf = 0
    let last = -1
    const tick = () => {
      const s = engine.getPositionSec()
      if (Math.abs(s - last) >= 0.05) {
        last = s
        setSec(s)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return sec
}
