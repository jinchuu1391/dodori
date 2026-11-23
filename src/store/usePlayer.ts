import { create } from 'zustand'
import { engine } from '../audio/engine'
import { type WaveLevels, buildWaveLevels } from '../audio/peaks'
import { sha256Hex } from '../audio/hash'
import { detectBeatGrid } from '../audio/detectBeats'
import * as repo from '../db/repo'
import type { BeatGrid, Region, Song } from '../types'
import { PITCH_MAX, PITCH_MIN, SPEED_MAX, SPEED_MIN } from '../types'
import { clamp } from '../util/time'

const LAST_SONG_KEY = 'dodori:lastSongId'

/** 첫 박을 찍을 때 BPM을 아직 안 정했으면 이걸로 시작한다 */
export const DEFAULT_BPM = 120
export const BPM_MIN = 30
export const BPM_MAX = 300

/** StrictMode가 개발 중 effect를 두 번 돌린다. 곡을 두 번 디코딩하지 않도록 막는다 */
let initStarted = false

export interface Selection {
  startSec: number
  endSec: number
}

interface HistoryAction {
  label: string
  undo: () => void | Promise<void>
  redo: () => void | Promise<void>
  mergeKey?: string
  recordedAt?: number
}

interface LoopState {
  selection: Selection | null
  activeRegionId: string | null
  loopRegionIds: string[]
  loopEnabled: boolean
  beatGrid: BeatGrid | null
  beatConfidence: number | null
}

interface PlayerState {
  songs: Song[]
  song: Song | null
  buffer: AudioBuffer | null
  /** 파형 렌더 데이터 — 곡을 열 때 메모리에서 만든다(저장하지 않음) */
  levels: WaveLevels | null
  regions: Region[]
  activeRegionId: string | null
  loopRegionIds: string[]

  selection: Selection | null
  loopEnabled: boolean

  isPlaying: boolean
  speed: number
  pitchSemitones: number
  volume: number

  status: string | null
  error: string | null
  undoLabel: string | null
  redoLabel: string | null
  historyBusy: boolean
  undo: () => Promise<void>
  redo: () => Promise<void>
  storage: { usedBytes: number; quotaBytes: number } | null

  init: () => Promise<void>
  openFiles: (files: FileList | File[]) => Promise<void>
  selectSong: (id: string) => Promise<void>
  removeSong: (id: string) => Promise<void>

  /** commit=false면 화면만 갱신하고 엔진 루프는 건드리지 않는다(드래그 중) */
  setSelection: (sel: Selection | null, commit?: boolean) => void
  saveSelectionAsRegion: (label: string) => Promise<void>
  applyRegion: (id: string) => void
  toggleLoopRegion: (id: string) => void
  renameRegion: (id: string, label: string) => Promise<void>
  removeRegion: (id: string) => Promise<void>

  togglePlay: () => Promise<void>
  seek: (sec: number) => void
  setLoopEnabled: (on: boolean) => void
  setSpeed: (v: number) => void
  setPitch: (v: number) => void
  setVolume: (v: number) => void

  /** 지금 쓰는 박자 격자. 구간을 고르면 그 구간 것으로, 새 구간은 이걸 물려받는다 */
  beatGrid: BeatGrid | null
  beatEditing: boolean
  setBeatEditing: (on: boolean) => void
  cancelBeatEditing: () => void
  cancelBeatDrag: () => void
  metronomeOn: boolean
  metronomeVolume: number
  /**
   * 편집 중에는 화면과 소리에만 반영한다. 편집을 완료하면 북마크에 저장한다.
   * commit=false는 드래그가 취소될 때 되돌릴 수 있도록 드래그 시작값을 남긴다.
   */
  setBeatGrid: (grid: BeatGrid | null, commit?: boolean) => void
  setMetronomeOn: (on: boolean) => void
  setMetronomeVolume: (v: number) => void
  /** 지금 위치를 1박으로 찍는다. BPM·박자는 쓰던 값(없으면 DEFAULT_BPM, 4/4) */
  markBeat: () => void
  /** 자동 박 감지 중 */
  beatDetecting: boolean
  /** 마지막 자동 감지의 신뢰도(Essentia 0–5.3, 1 미만이면 믿기 어려움). 첫 박을 손으로 찍으면 지운다 */
  beatConfidence: number | null
  /**
   * 고른 구간(없으면 곡 전체)을 분석해 BPM과 첫 박을 채우고 메트로놈을 켠다.
   * 첫 박은 구간 시작 이후 첫 박 — 강박(마디 1박)까지는 알지 못한다.
   */
  autoDetectBeat: () => Promise<void>
}

export const usePlayer = create<PlayerState>()((set, get) => {
  let beatEditSession = 0
  let beatGridBeforeDrag: BeatGrid | null | undefined
  let beatEditStart: Pick<PlayerState, 'beatGrid' | 'beatConfidence' | 'metronomeOn'> | undefined
  const past: HistoryAction[] = []
  const future: HistoryAction[] = []
  let replaying = false
  let mutationQueue = Promise.resolve()
  let pendingMutations = 0
  let loopBeforeDrag: LoopState | undefined

  const publishHistory = () => set({
    undoLabel: past.at(-1)?.label ?? null,
    redoLabel: future.at(-1)?.label ?? null,
    historyBusy: replaying || pendingMutations > 0,
  })

  const record = (action: HistoryAction) => {
    if (replaying) return
    const last = past.at(-1)
    const now = Date.now()
    if (last && future.length === 0 && action.mergeKey && action.mergeKey === last.mergeKey &&
        last.recordedAt !== undefined && now - last.recordedAt < 400) {
      past[past.length - 1] = { ...action, undo: last.undo, recordedAt: now }
    } else {
      past.push({ ...action, recordedAt: now })
      if (past.length > 50) past.shift()
    }
    future.length = 0
    publishHistory()
  }

  const replay = async (from: HistoryAction[], to: HistoryAction[], direction: 'undo' | 'redo') => {
    const action = from.at(-1)
    if (!action || get().historyBusy || get().beatEditing || loopBeforeDrag) return
    replaying = true
    publishHistory()
    try {
      await action[direction]()
      from.pop()
      to.push({ ...action, recordedAt: undefined })
    } catch (error) {
      console.error(error)
      set({ error: direction === 'undo' ? '실행 취소에 실패했습니다.' : '다시 실행에 실패했습니다.' })
    } finally {
      replaying = false
      publishHistory()
    }
  }

  const mutate = (action: () => Promise<void>): Promise<void> => {
    if (replaying) return Promise.resolve()
    pendingMutations++
    publishHistory()
    mutationQueue = mutationQueue.then(action).catch((error: unknown) => {
      console.error(error)
      set({ error: '변경을 저장하지 못했습니다.' })
    }).finally(() => {
      pendingMutations--
      publishHistory()
    })
    return mutationQueue
  }

  const captureLoop = (): LoopState => {
    const { selection, activeRegionId, loopRegionIds, loopEnabled, beatGrid, beatConfidence } = get()
    return {
      selection, activeRegionId, loopRegionIds, loopEnabled,
      beatGrid: beatEditStart ? beatEditStart.beatGrid : beatGrid,
      beatConfidence: beatEditStart ? beatEditStart.beatConfidence : beatConfidence,
    }
  }

  /** 선택 구간 + 루프 스위치를 엔진에 반영 */
  const syncLoop = () => {
    const { selection, loopEnabled, loopRegionIds, regions } = get()
    if (!loopEnabled) engine.setLoopRanges([])
    else if (loopRegionIds.length > 1) engine.setLoopRanges(regions.filter((region) => loopRegionIds.includes(region.id)))
    else engine.setLoopRanges(selection ? [selection] : [])
  }

  const syncMetronome = () => {
    const { metronomeOn, beatGrid } = get()
    engine.setMetronome(metronomeOn, beatGrid)
  }

  const selectRegion = (region: Region, loopRegionIds: string[]) => {
    get().cancelBeatEditing()
    set({
      selection: { startSec: region.startSec, endSec: region.endSec },
      activeRegionId: region.id,
      loopRegionIds,
      ...(region.beatGrid ? { beatGrid: region.beatGrid, beatConfidence: null } : {}),
    })
    syncMetronome()
  }

  const refreshStorage = async () => {
    set({ storage: await repo.estimateStorage() })
  }

  const restoreLoop = (snapshot: LoopState) => {
    const existingIds = new Set(get().regions.map(({ id }) => id))
    set({
      ...snapshot,
      activeRegionId: snapshot.activeRegionId && existingIds.has(snapshot.activeRegionId) ? snapshot.activeRegionId : null,
      loopRegionIds: snapshot.loopRegionIds.filter((id) => existingIds.has(id)),
    })
    syncLoop()
    syncMetronome()
  }

  const recordLoop = (label: string, songId: string, before: LoopState) => {
    const after = captureLoop()
    const apply = async (snapshot: LoopState) => {
      if (get().song?.id !== songId) await get().selectSong(songId)
      if (get().song?.id !== songId) throw new Error('곡을 열 수 없습니다.')
      restoreLoop(snapshot)
    }
    record({ label, undo: () => apply(before), redo: () => apply(after) })
  }

  const changeSetting = <T>(
    label: string, before: T, after: T, apply: (value: T) => void, mergeKey?: string,
  ) => {
    if (replaying || Object.is(before, after)) return
    apply(after)
    record({ label, undo: () => apply(before), redo: () => apply(after), mergeKey })
  }

  const refreshRegions = async (songId: string, snapshot?: LoopState) => {
    const regions = await repo.listRegions(songId)
    if (get().song?.id !== songId) return
    set({ regions })
    if (snapshot) restoreLoop(snapshot)
  }

  const refreshLibrary = async (removedIds: string[] = []) => {
    const activeId = get().song?.id
    if (activeId && removedIds.includes(activeId)) {
      get().cancelBeatEditing()
      engine.unload()
      localStorage.removeItem(LAST_SONG_KEY)
      loopBeforeDrag = undefined
      set({
        song: null, buffer: null, levels: null, regions: [], selection: null,
        activeRegionId: null, loopRegionIds: [], isPlaying: false, beatGrid: null, beatConfidence: null,
      })
    }
    set({ songs: await repo.listSongs() })
    await refreshStorage()
  }

  return {
    songs: [],
    song: null,
    buffer: null,
    levels: null,
    regions: [],
    activeRegionId: null,
    loopRegionIds: [],
    selection: null,
    loopEnabled: true,
    isPlaying: false,
    speed: 1,
    pitchSemitones: 0,
    volume: 1,
    beatGrid: null,
    beatEditing: false,
    metronomeOn: false,
    metronomeVolume: 0.8,
    beatDetecting: false,
    beatConfidence: null,
    status: null,
    error: null,
    undoLabel: null,
    redoLabel: null,
    historyBusy: false,
    undo: () => replay(past, future, 'undo'),
    redo: () => replay(future, past, 'redo'),
    storage: null,

    async init() {
      if (initStarted) return
      initStarted = true
      engine.on({ onEnded: () => set({ isPlaying: false }) })
      engine.setVolume(get().volume)
      const songs = await repo.listSongs()
      set({ songs })
      await refreshStorage()

      const last = localStorage.getItem(LAST_SONG_KEY)
      if (last && songs.some((s) => s.id === last)) {
        await get().selectSong(last)
      }
    },

    openFiles(files) {
      const list = Array.from(files).filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|flac)$/i.test(f.name))
      if (list.length === 0) {
        set({ error: '오디오 파일이 아닙니다.' })
        return Promise.resolve()
      }
      return mutate(async () => {
        const added: repo.SongContents[] = []
        let lastId: string | null = null
        for (const file of list) {
          try {
            set({ status: `${file.name} 읽는 중…`, error: null })
            const raw = await file.arrayBuffer()
            const fileHash = await sha256Hex(raw)

            const existing = await repo.findSongByHash(fileHash)
            if (existing) {
              lastId = existing.id
              continue
            }

            set({ status: `${file.name} 디코딩 중…` })
            // decodeAudioData는 넘긴 ArrayBuffer를 detach한다. 원본은 File(Blob)로 따로 보관한다
            const buffer = await engine.decode(raw)

            const song = await repo.addSong({
              title: file.name.replace(/\.[^.]+$/, ''),
              durationSec: buffer.duration,
              fileHash,
              fileBlob: file,
            })
            added.push({ song, regions: [], sessions: [] })
            lastId = song.id
          } catch (e) {
            set({ error: `${file.name}: ${e instanceof Error ? e.message : '열 수 없습니다'}` })
          }
        }

        set({ status: null, songs: await repo.listSongs() })
        await refreshStorage()
        if (lastId) await get().selectSong(lastId)
        if (added.length) {
          const ids = added.map(({ song }) => song.id)
          record({
            label: '곡 추가',
            undo: async () => {
              await repo.deleteSongs(ids)
              await refreshLibrary(ids)
            },
            redo: async () => {
              await repo.restoreSongs(added)
              await refreshLibrary()
              if (!get().song) await get().selectSong(ids.at(-1)!)
            },
          })
        }
      })
    },

    async selectSong(id) {
      const song = await repo.getSong(id)
      if (!song?.fileBlob) {
        set({ error: '이 기기에 원본 파일이 없습니다.' })
        return
      }

      engine.pause()
      loopBeforeDrag = undefined
      get().cancelBeatEditing()
      set({
        status: '불러오는 중…', error: null, isPlaying: false, selection: null, activeRegionId: null,
        loopRegionIds: [], beatGrid: null, beatConfidence: null,
      })

      try {
        const buffer = await engine.decode(await song.fileBlob.arrayBuffer())
        engine.load(buffer)
        engine.setSpeed(get().speed)
        engine.setPitchSemitones(get().pitchSemitones)
        engine.setMetronomeVolume(get().metronomeVolume)
        syncMetronome()

        const levels = buildWaveLevels(buffer)

        const regions = await repo.listRegions(song.id)
        set({ song, buffer, levels, regions, status: null })
        localStorage.setItem(LAST_SONG_KEY, song.id)
        await repo.touchSong(song.id)
        syncLoop()
      } catch (e) {
        set({ status: null, error: e instanceof Error ? e.message : '디코딩 실패' })
      }
    },

    removeSong(id) {
      return mutate(async () => {
        const wasActive = get().song?.id === id
        const before = captureLoop()
        const removed = await repo.deleteSongs([id])
        if (!removed.length) return
        await refreshLibrary([id])
        record({
          label: '곡 삭제',
          undo: async () => {
            await repo.restoreSongs(removed)
            await refreshLibrary()
            if (wasActive && !get().song) {
              await get().selectSong(id)
              if (get().song?.id === id) restoreLoop(before)
            }
          },
          redo: async () => {
            await repo.deleteSongs([id])
            await refreshLibrary([id])
          },
        })
      })
    },

    /**
     * 드래그 중에는 commit=false. A-B가 바뀔 때마다 engine.setLoop을 부르면
     * SimpleFilter가 매번 clear()되어 소리가 튄다. 손을 뗄 때 한 번만 반영한다.
     */
    setSelection(sel, commit = true) {
      if (replaying) return
      const songId = get().song?.id
      const before = loopBeforeDrag ?? captureLoop()
      loopBeforeDrag = commit ? undefined : before
      if (get().activeRegionId) get().cancelBeatEditing()
      set({ selection: sel, activeRegionId: null, loopRegionIds: [] })
      if (!commit) return
      syncLoop()
      if (songId && (before.activeRegionId || before.selection?.startSec !== sel?.startSec || before.selection?.endSec !== sel?.endSec)) {
        recordLoop(sel ? '구간 설정' : '구간 해제', songId, before)
      }
    },

    saveSelectionAsRegion(label) {
      const { song, selection, beatGrid } = get()
      const savedGrid = beatEditStart ? beatEditStart.beatGrid : beatGrid
      const title = label.trim()
      if (!song || !selection || !title) return Promise.resolve()
      return mutate(async () => {
        const before = captureLoop()
        const region = await repo.addRegion({
          songId: song.id,
          label: title,
          startSec: selection.startSec,
          endSec: selection.endSec,
          ...(savedGrid ? { beatGrid: savedGrid } : {}),
        })
        const regions = await repo.listRegions(song.id)
        const selected = get().song?.id === song.id && get().selection === selection
        if (get().song?.id === song.id) {
          set({ regions, ...(selected ? { activeRegionId: region.id, loopRegionIds: [region.id] } : {}) })
        }
        const after = captureLoop()
        record({
          label: '북마크 저장',
          undo: async () => {
            await repo.removeRegion(region.id)
            await refreshRegions(song.id, selected ? before : undefined)
          },
          redo: async () => {
            await repo.restoreRegion(region)
            await refreshRegions(song.id, selected ? after : undefined)
          },
        })
      })
    },

    applyRegion(id) {
      if (replaying) return
      const { regions, activeRegionId, loopRegionIds } = get()
      const region = regions.find((r) => r.id === id)
      if (!region) return
      const before = captureLoop()
      selectRegion(region, [id])
      syncLoop()
      engine.seekSec(region.startSec)
      if (activeRegionId !== id || loopRegionIds.length > 1) recordLoop('북마크 선택', region.songId, before)
    },

    toggleLoopRegion(id) {
      const { song, activeRegionId, loopRegionIds, regions } = get()
      if (replaying || !song || !activeRegionId || !regions.some((region) => region.id === id)) return
      const before = captureLoop()
      if (!loopRegionIds.includes(id)) {
        set({ loopRegionIds: [...loopRegionIds, id], loopEnabled: true })
      } else {
        if (loopRegionIds.length < 2) return
        const remaining = loopRegionIds.filter((regionId) => regionId !== id)
        const next = regions.find((region) => region.id === remaining[0])
        if (id === activeRegionId && next) selectRegion(next, remaining)
        else set({ loopRegionIds: remaining })
      }
      syncLoop()
      recordLoop(loopRegionIds.includes(id) ? '반복에서 북마크 빼기' : '반복에 북마크 추가', song.id, before)
    },

    renameRegion(id, label) {
      const songId = get().song?.id
      return mutate(async () => {
        const previous = await repo.getRegion(id)
        if (!previous || previous.deletedAt || previous.songId !== songId) return
        const title = label.trim()
        if (!title || previous.label === title) return
        const apply = async (title: string) => {
          await repo.updateRegion(id, { label: title })
          await refreshRegions(previous.songId)
        }
        await apply(title)
        record({ label: '북마크 이름 변경', undo: () => apply(previous.label), redo: () => apply(title) })
      })
    },

    removeRegion(id) {
      const songId = get().song?.id
      return mutate(async () => {
        const region = await repo.getRegion(id)
        if (!region || region.deletedAt || region.songId !== songId) return
        await repo.removeRegion(id)
        const regions = await repo.listRegions(region.songId)
        const state = get()
        const before = captureLoop()
        const included = state.song?.id === region.songId && state.loopRegionIds.includes(id)
        if (state.song?.id === region.songId) {
          const remaining = state.loopRegionIds.filter((regionId) => regionId !== id)
          set({ regions, loopRegionIds: remaining })
          if (state.activeRegionId === id) {
            const next = regions.find((item) => item.id === remaining[0])
            if (next) selectRegion(next, remaining)
            else {
              get().cancelBeatEditing()
              set({ activeRegionId: null })
            }
          }
          if (included) syncLoop()
        }
        const after = captureLoop()
        record({
          label: '북마크 삭제',
          undo: async () => {
            await repo.restoreRegion(region)
            await refreshRegions(region.songId, included ? before : undefined)
          },
          redo: async () => {
            await repo.removeRegion(id)
            await refreshRegions(region.songId, included ? after : undefined)
          },
        })
      })
    },

    async togglePlay() {
      if (!engine.isLoaded) return
      await engine.toggle()
      set({ isPlaying: engine.isPlaying })
    },

    seek(sec) {
      engine.seekSec(sec)
    },

    setLoopEnabled(on) {
      changeSetting('구간 반복', get().loopEnabled, on, (loopEnabled) => {
        set({ loopEnabled })
        syncLoop()
      })
    },

    setSpeed(v) {
      const speed = clamp(Number(v.toFixed(2)), SPEED_MIN, SPEED_MAX)
      changeSetting('재생 속도', get().speed, speed, (value) => {
        engine.setSpeed(value)
        set({ speed: value })
      }, 'speed')
    },

    setBeatEditing(on) {
      const { beatEditing, buffer, beatGrid, beatConfidence, metronomeOn, activeRegionId } = get()
      if (replaying || on === beatEditing || (on && !buffer)) return
      beatEditSession++
      if (on) {
        beatEditStart = { beatGrid, beatConfidence, metronomeOn }
        set({ beatEditing: true })
        return
      }

      get().cancelBeatDrag()
      const grid = get().beatGrid
      const original = beatEditStart
      const current = { beatGrid: grid, beatConfidence: get().beatConfidence, metronomeOn: get().metronomeOn }
      beatEditStart = undefined
      set({ beatEditing: false })
      if (!original || grid === original.beatGrid) return
      const songId = get().song?.id
      const previousGrid = get().regions.find((region) => region.id === activeRegionId)?.beatGrid
      const apply = async (snapshot: typeof current, storedGrid: BeatGrid | undefined) => {
        if (activeRegionId && songId) {
          await repo.updateRegion(activeRegionId, { beatGrid: storedGrid })
          await refreshRegions(songId)
        } else if (replaying && songId && get().song?.id !== songId) {
          await get().selectSong(songId)
          if (get().song?.id !== songId) throw new Error('곡을 열 수 없습니다.')
        }
        if (get().song?.id === songId && get().activeRegionId === activeRegionId) {
          set(snapshot)
          syncMetronome()
        }
      }
      if (!activeRegionId || !songId) {
        record({ label: '박자 설정', undo: () => apply(original, undefined), redo: () => apply(current, undefined) })
        return
      }
      void mutate(async () => {
        try {
          await repo.updateRegion(activeRegionId, { beatGrid: grid ?? undefined })
          await refreshRegions(songId)
          record({ label: '박자 설정', undo: () => apply(original, previousGrid), redo: () => apply(current, grid ?? undefined) })
        } catch (error) {
          if (get().song?.id === songId && get().activeRegionId === activeRegionId &&
              get().beatGrid === grid && !get().beatEditing) {
            set(original)
            syncMetronome()
          }
          throw error
        }
      })
    },

    cancelBeatEditing() {
      if (!beatEditStart) return
      const original = beatEditStart
      beatEditSession++
      beatEditStart = undefined
      beatGridBeforeDrag = undefined
      set({ ...original, beatEditing: false })
      syncMetronome()
    },

    cancelBeatDrag() {
      if (beatGridBeforeDrag === undefined) return
      const beatGrid = beatGridBeforeDrag
      beatGridBeforeDrag = undefined
      set({ beatGrid })
      syncMetronome()
    },

    setBeatGrid(grid, commit = true) {
      if (!get().beatEditing) return
      if (commit) beatGridBeforeDrag = undefined
      else if (beatGridBeforeDrag === undefined) beatGridBeforeDrag = get().beatGrid
      set({ beatGrid: grid })
      syncMetronome()
    },

    setMetronomeOn(on) {
      changeSetting('메트로놈 켜기·끄기', get().metronomeOn, on, (metronomeOn) => {
        if (beatEditStart) beatEditStart.metronomeOn = metronomeOn
        set({ metronomeOn })
        syncMetronome()
      })
    },

    setMetronomeVolume(v) {
      const metronomeVolume = clamp(v, 0, 1)
      changeSetting('메트로놈 음량', get().metronomeVolume, metronomeVolume, (value) => {
        engine.setMetronomeVolume(value)
        set({ metronomeVolume: value })
      }, 'metronomeVolume')
    },

    markBeat() {
      if (!get().beatEditing || !engine.isLoaded) return
      const g = get().beatGrid
      set({ beatConfidence: null })
      get().setBeatGrid({
        bpm: g?.bpm ?? DEFAULT_BPM,
        anchorSec: engine.getPositionSec(),
        beatsPerBar: g?.beatsPerBar ?? 4,
      })
    },

    async autoDetectBeat() {
      const { buffer, song, selection, beatDetecting, beatEditing } = get()
      if (!buffer || !song || beatDetecting || !beatEditing) return
      const session = beatEditSession
      const isCurrent = () => beatEditSession === session && get().song?.id === song.id && get().selection === selection
      const startSec = selection?.startSec ?? 0
      const endSec = selection?.endSec ?? buffer.duration
      set({ beatDetecting: true, status: '박 분석 중…', error: null })
      try {
        const found = await detectBeatGrid(buffer, startSec, endSec)
        if (!isCurrent()) return
        if (!found) {
          set({ error: '박을 찾지 못했어요. "첫 박 찍기"로 직접 잡아 주세요.' })
          return
        }
        const bpm = clamp(found.bpm, BPM_MIN, BPM_MAX)
        set({ beatConfidence: found.confidence, metronomeOn: true })
        get().setBeatGrid({ bpm, anchorSec: found.anchorSec, beatsPerBar: get().beatGrid?.beatsPerBar ?? 4 })
      } catch (err) {
        console.error(err)
        if (isCurrent()) set({ error: '박 분석에 실패했어요.' })
      } finally {
        set({ beatDetecting: false })
        if (get().status === '박 분석 중…') set({ status: null })
      }
    },

    setPitch(v) {
      const pitchSemitones = clamp(Math.round(v), PITCH_MIN, PITCH_MAX)
      changeSetting('키 조정', get().pitchSemitones, pitchSemitones, (value) => {
        engine.setPitchSemitones(value)
        set({ pitchSemitones: value })
      })
    },

    setVolume(v) {
      const volume = clamp(v, 0, 1)
      changeSetting('재생 음량', get().volume, volume, (value) => {
        engine.setVolume(value)
        set({ volume: value })
      }, 'volume')
    },
  }
})
