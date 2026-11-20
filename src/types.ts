/**
 * 설계 문서 05 데이터 모델과 1:1로 맞춘 타입.
 * userId / fileHash / updatedAt / deletedAt 은 M1에서는 쓰이지 않지만,
 * M3에서 붙일 때 기존 로컬 데이터를 마이그레이션하지 않으려고 처음부터 넣어둔다.
 */

/** 곡 — 원본 mp3와 메타데이터 */
export interface Song {
  id: string
  userId?: string
  title: string
  artist?: string
  durationSec: number
  /** 내용 해시 — 기기 간 같은 곡 식별 */
  fileHash: string
  /** 로컬 원본(IndexedDB). M3 모바일에서는 없을 수 있다 */
  fileBlob?: Blob
  /** M3: Supabase Storage 경로(선택 업로드) */
  remotePath?: string
  /** @deprecated 예전 파형 캐시. 이제 곡을 열 때 메모리에서 만들고 이 값은 읽지 않는다 */
  peaks?: number[]
  createdAt: number
  updatedAt: number
  lastPracticedAt?: number
}

/** 드릴 설정 — 독립 테이블이 아니라 Region에 embed된다 */
export interface DrillSettings {
  loopCount: number | 'infinite'
  gapSec: number
  /** 0.5 – 1.0 (피치 유지) */
  speed: number
  /** -6 – +6 */
  pitchSemitones: number
  countIn: boolean
  metronomeBpm?: number
  progressive?: {
    startSpeed: number
    step: number
    targetSpeed: number
  }
}

/** 구간 — A-B 반복 지점이자 북마크 */
export interface Region {
  id: string
  songId: string
  label: string
  startSec: number
  endSec: number
  color?: string
  drill?: DrillSettings
  /** 이 구간의 박자 격자(메트로놈). 없으면 직전에 쓰던 격자를 이어 쓴다 */
  beatGrid?: BeatGrid
  updatedAt: number
  /** tombstone — 삭제도 동기화되어야 한다 */
  deletedAt?: number
}

/** 연습 기록 — 통계/동기부여용 */
export interface PracticeSession {
  id: string
  songId: string
  regionId?: string
  startedAt: number
  reps: number
  practiceSec: number
}

export const DEFAULT_DRILL: DrillSettings = {
  loopCount: 'infinite',
  gapSec: 0,
  speed: 1,
  pitchSemitones: 0,
  countIn: false,
}

export const SPEED_MIN = 0.5
export const SPEED_MAX = 1.25
export const PITCH_MIN = -6
export const PITCH_MAX = 6

/**
 * 박자 격자 — 메트로놈 클릭과 파형 위 박자 눈금의 기준. 곡의 시간축에 고정된다.
 * anchorSec은 아무 박 하나(그 박이 1박). 구간 반복 시작점 A와는 무관하다.
 * 템포가 바뀌는 곡은 구간(Region)마다 따로 둔다.
 */
export interface BeatGrid {
  bpm: number
  anchorSec: number
  /** 한 마디 박 수 — 1박에 강박 클릭 */
  beatsPerBar: number
}
