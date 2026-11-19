import Dexie, { type EntityTable } from 'dexie'
import type { PracticeSession, Region, Song } from '../types'

/**
 * IndexedDB 스키마. 여기서 인덱스만 선언하고,
 * 실제 접근은 전부 repo.ts를 통한다 — M3에서 Supabase를 붙일 때 바꿀 경계.
 */
export const db = new Dexie('dodori') as Dexie & {
  songs: EntityTable<Song, 'id'>
  regions: EntityTable<Region, 'id'>
  sessions: EntityTable<PracticeSession, 'id'>
}

db.version(1).stores({
  songs: 'id, fileHash, createdAt, lastPracticedAt',
  regions: 'id, songId, updatedAt',
  sessions: 'id, songId, startedAt',
})
