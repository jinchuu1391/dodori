import { useRef } from 'react'
import { usePlayer } from '../store/usePlayer'
import { formatBytes, formatTime } from '../util/time'

export function Library() {
  const songs = usePlayer((s) => s.songs)
  const current = usePlayer((s) => s.song)
  const selectSong = usePlayer((s) => s.selectSong)
  const removeSong = usePlayer((s) => s.removeSong)
  const openFiles = usePlayer((s) => s.openFiles)
  const storage = usePlayer((s) => s.storage)
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <aside className="library">
      <div className="lib-head">
        <h2>라이브러리</h2>
        <button className="add" onClick={() => inputRef.current?.click()}>
          + 곡 추가
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void openFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {songs.length === 0 ? (
        <p className="lib-empty">
          아직 곡이 없습니다.
          <br />
          mp3를 추가하면 이 기기에만 저장됩니다.
        </p>
      ) : (
        <ul className="song-list">
          {songs.map((s) => (
            <li key={s.id} className={s.id === current?.id ? 'active' : undefined}>
              <button className="song" onClick={() => void selectSong(s.id)}>
                <span className="s-title">{s.title}</span>
                <span className="s-meta">{formatTime(s.durationSec)}</span>
              </button>
              <button
                className="del"
                title="삭제"
                aria-label={`${s.title} 삭제`}
                onClick={() => {
                  if (confirm(`"${s.title}"을(를) 삭제할까요? 저장한 구간도 함께 지워집니다.`)) {
                    void removeSong(s.id)
                  }
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {storage && storage.quotaBytes > 0 && (
        <div className="quota" title="브라우저가 이 사이트에 허용한 저장 용량">
          <div className="bar">
            <span style={{ width: `${Math.min(100, (storage.usedBytes / storage.quotaBytes) * 100)}%` }} />
          </div>
          <small>
            {formatBytes(storage.usedBytes)} / {formatBytes(storage.quotaBytes)} 사용
          </small>
        </div>
      )}
    </aside>
  )
}
