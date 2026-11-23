import { usePlayer } from '../store/usePlayer'
import { formatTime } from '../util/time'

export function RegionList() {
  const regions = usePlayer((s) => s.regions)
  const activeRegionId = usePlayer((s) => s.activeRegionId)
  const loopRegionIds = usePlayer((s) => s.loopRegionIds)
  const loopEnabled = usePlayer((s) => s.loopEnabled)
  const toggleLoopRegion = usePlayer((s) => s.toggleLoopRegion)
  const applyRegion = usePlayer((s) => s.applyRegion)
  const renameRegion = usePlayer((s) => s.renameRegion)
  const removeRegion = usePlayer((s) => s.removeRegion)
  const song = usePlayer((s) => s.song)

  if (!song) return null
  const included = regions.filter((region) => loopRegionIds.includes(region.id))
  const first = Math.max(0, included.findIndex((region) => region.id === activeRegionId))
  const order = [...included.slice(first), ...included.slice(0, first)]

  return (
    <div className="regions">
      <h3>
        구간 북마크{regions.length > 0 && <span className="count">{regions.length}</span>}
      </h3>
      {regions.length === 0 ? (
        <p className="hint">저장한 구간이 없습니다. 위쪽 시간 눈금을 드래그해 구간을 잡고 저장하세요.</p>
      ) : (
        <ul>
          {regions.map((r) => {
            const loopIndex = order.findIndex((region) => region.id === r.id)
            const inLoop = loopIndex >= 0
            return (
              <li key={r.id} className={r.id === activeRegionId ? 'active' : undefined}>
                <button className="go" onClick={() => applyRegion(r.id)}>
                  <span className="r-label">
                    {order.length > 1 && inLoop && (
                      <span className="r-order" aria-label={`반복 순서 ${loopIndex + 1}`}>{loopIndex + 1}</span>
                    )}
                    {r.label}
                  </span>
                  <span className="r-time">
                    {formatTime(r.startSec)} – {formatTime(r.endSec)}
                  </span>
                  <span className="r-len">{(r.endSec - r.startSec).toFixed(1)}초</span>
                </button>
                {activeRegionId && (!inLoop || order.length > 1) && (
                  <button
                    className="r-loop"
                    title={inLoop ? '반복에서 빼기' : '반복에 추가'}
                    aria-label={`${r.label} ${inLoop ? '반복에서 빼기' : '반복에 추가'}`}
                    aria-pressed={inLoop && loopEnabled}
                    onClick={() => toggleLoopRegion(r.id)}
                  >
                    {inLoop ? '−' : '+'} 반복
                  </button>
                )}
                <button
                  className="icon"
                  title="이름 변경"
                  aria-label={`${r.label} 이름 변경`}
                  onClick={() => {
                    const next = prompt('구간 이름', r.label)
                    if (next !== null) void renameRegion(r.id, next.trim() || r.label)
                  }}
                >
                  ✎
                </button>
                <button
                  className="icon"
                  title="삭제"
                  aria-label={`${r.label} 삭제`}
                  onClick={() => void removeRegion(r.id)}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
