import { usePlayer } from '../store/usePlayer'
import { PITCH_MAX, PITCH_MIN, SPEED_MAX, SPEED_MIN } from '../types'
import { formatTime } from '../util/time'
import { usePlayheadSec } from '../util/usePlayhead'

export function Transport() {
  const song = usePlayer((s) => s.song)
  const buffer = usePlayer((s) => s.buffer)
  const isPlaying = usePlayer((s) => s.isPlaying)
  const togglePlay = usePlayer((s) => s.togglePlay)
  const speed = usePlayer((s) => s.speed)
  const setSpeed = usePlayer((s) => s.setSpeed)
  const pitch = usePlayer((s) => s.pitchSemitones)
  const setPitch = usePlayer((s) => s.setPitch)
  const volume = usePlayer((s) => s.volume)
  const setVolume = usePlayer((s) => s.setVolume)

  const pos = usePlayheadSec()
  const duration = buffer?.duration ?? 0
  const disabled = !buffer

  return (
    <div className="transport">
      <button
        className="play"
        onClick={() => void togglePlay()}
        disabled={disabled}
        aria-label={isPlaying ? '일시정지' : '재생'}
        title="스페이스바"
      >
        {isPlaying ? '❚❚' : '▶'}
      </button>

      <div className="now">
        <div className="title">{song?.title ?? '곡 없음'}</div>
        <div className="clock">
          <span className="cur">{formatTime(pos)}</span>
          <span className="sep">/</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="ctl">
        <label htmlFor="speed">
          속도 <b>{speed.toFixed(2)}×</b>
        </label>
        <input
          id="speed"
          type="range"
          min={SPEED_MIN}
          max={SPEED_MAX}
          step={0.05}
          value={speed}
          disabled={disabled}
          onChange={(e) => setSpeed(Number(e.target.value))}
        />
      </div>

      <div className="ctl">
        <label htmlFor="pitch">
          키 <b>{pitch > 0 ? `+${pitch}` : pitch}</b>
        </label>
        <div className="stepper">
          <button onClick={() => setPitch(pitch - 1)} disabled={disabled || pitch <= PITCH_MIN} aria-label="키 내리기">
            −
          </button>
          <button onClick={() => setPitch(0)} disabled={disabled} className="reset" aria-label="키 초기화">
            0
          </button>
          <button onClick={() => setPitch(pitch + 1)} disabled={disabled || pitch >= PITCH_MAX} aria-label="키 올리기">
            +
          </button>
        </div>
      </div>

      <div className="ctl vol">
        <label htmlFor="vol">볼륨</label>
        <input
          id="vol"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </div>
    </div>
  )
}
