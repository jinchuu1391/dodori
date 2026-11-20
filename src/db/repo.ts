import { db } from './db'
import type { BeatGrid, DrillSettings, PracticeSession, Region, Song } from '../types'

/**
 * 저장소 경계. 컴포넌트는 Dexie를 직접 만지지 않는다.
 * M3에서 Supabase 동기화를 붙일 때 이 파일만 "로컬 쓰고 → 큐에 넣고 → 푸시"로 바뀐다.
 */

export const uid = () => crypto.randomUUID()
const now = () => Date.now()

/* ---------- 곡 ---------- */

export function listSongs(): Promise<Song[]> {
  return db.songs.orderBy('createdAt').reverse().toArray()
}

export function getSong(id: string): Promise<Song | undefined> {
  return db.songs.get(id)
}

export function findSongByHash(fileHash: string): Promise<Song | undefined> {
  return db.songs.where('fileHash').equals(fileHash).first()
}

export async function addSong(
  input: Omit<Song, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<Song> {
  const song: Song = { ...input, id: uid(), createdAt: now(), updatedAt: now() }
  await db.songs.add(song)
  return song
}

export async function updateSong(id: string, patch: Partial<Song>): Promise<void> {
  await db.songs.update(id, { ...patch, updatedAt: now() })
}

export async function touchSong(id: string): Promise<void> {
  await db.songs.update(id, { lastPracticedAt: now() })
}

export async function deleteSong(id: string): Promise<void> {
  await db.transaction('rw', db.songs, db.regions, db.sessions, async () => {
    await db.regions.where('songId').equals(id).delete()
    await db.sessions.where('songId').equals(id).delete()
    await db.songs.delete(id)
  })
}

/* ---------- 구간 ---------- */

/** tombstone(deletedAt)이 찍힌 구간은 걸러서 돌려준다 */
export async function listRegions(songId: string): Promise<Region[]> {
  const rows = await db.regions.where('songId').equals(songId).toArray()
  return rows.filter((r) => !r.deletedAt).sort((a, b) => a.startSec - b.startSec)
}

export async function addRegion(input: {
  songId: string
  label: string
  startSec: number
  endSec: number
  drill?: DrillSettings
  beatGrid?: BeatGrid
}): Promise<Region> {
  const region: Region = { ...input, id: uid(), updatedAt: now() }
  await db.regions.add(region)
  return region
}

export async function updateRegion(id: string, patch: Partial<Region>): Promise<void> {
  await db.regions.update(id, { ...patch, updatedAt: now() })
}

/**
 * 물리 삭제가 아니라 tombstone. 지금은 혼자 쓰지만, M3에서 다른 기기가
 * "이 구간 아직 있는데?" 하며 되살리는 걸 막으려면 삭제도 기록으로 남아야 한다.
 */
export async function removeRegion(id: string): Promise<void> {
  await db.regions.update(id, { deletedAt: now(), updatedAt: now() })
}

/* ---------- 연습 기록 ---------- */

export async function addSession(
  input: Omit<PracticeSession, 'id'>,
): Promise<PracticeSession> {
  const session: PracticeSession = { ...input, id: uid() }
  await db.sessions.add(session)
  return session
}

/* ---------- 저장 용량 ---------- */

export async function estimateStorage(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage, quota } = await navigator.storage.estimate()
  return { usedBytes: usage ?? 0, quotaBytes: quota ?? 0 }
}
