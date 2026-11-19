import { usePlayer } from '../store/usePlayer'
import { formatTime } from '../util/time'

export function RegionList() {
  const regions = usePlayer((s) => s.regions)
  const activeRegionId = usePlayer((s) => s.activeRegionId)
  const applyRegion = usePlayer((s) => s.applyRegion)
  const renameRegion = usePlayer((s) => s.renameRegion)
  const removeRegion = usePlayer((s) => s.removeRegion)
  const song = usePlayer((s) => s.song)

  if (!song) return null

  return (
    <div className="regions">
      <h3>구간 북마크</h3>
      {regions.length === 0 ? (
        <p className="hint">저장한 구간이 없습니다. 파형에서 구간을 잡고 저장하세요.</p>
      ) : (
        <ul>
          {regions.map((r) => (
            <li key={r.id} className={r.id === activeRegionId ? 'active' : undefined}>
              <button className="go" onClick={() => applyRegion(r.id)}>
                <span className="r-label">{r.label}</span>
                <span className="r-time">
                  {formatTime(r.startSec)} – {formatTime(r.endSec)}
                </span>
              </button>
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
          ))}
        </ul>
      )}
    </div>
  )
}
