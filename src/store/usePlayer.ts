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
  metronomeOn: boolean
  metronomeVolume: number
  /**
   * commit=false면 화면·소리만 바꾸고 저장하지 않는다(박자 선 드래그 중).
   * 고른 북마크가 있으면 그 구간에 저장한다.
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
    metronomeOn: false,
    metronomeVolume: 0.8,
    beatDetecting: false,
    beatConfidence: null,
    status: null,
    error: null,
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

    async openFiles(files) {
      const list = Array.from(files).filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|flac)$/i.test(f.name))
      if (list.length === 0) {
        set({ error: '오디오 파일이 아닙니다.' })
        return
      }

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
          lastId = song.id
        } catch (e) {
          set({ error: `${file.name}: ${e instanceof Error ? e.message : '열 수 없습니다'}` })
        }
      }

      set({ status: null, songs: await repo.listSongs() })
      await refreshStorage()
      if (lastId) await get().selectSong(lastId)
    },

    async selectSong(id) {
      const song = await repo.getSong(id)
      if (!song?.fileBlob) {
        set({ error: '이 기기에 원본 파일이 없습니다.' })
        return
      }

      engine.pause()
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

    async removeSong(id) {
      await repo.deleteSong(id)
      if (get().song?.id === id) {
        engine.unload()
        localStorage.removeItem(LAST_SONG_KEY)
        set({
          song: null, buffer: null, levels: null, regions: [], selection: null,
          activeRegionId: null, loopRegionIds: [], isPlaying: false,
        })
      }
      set({ songs: await repo.listSongs() })
      await refreshStorage()
    },

    /**
     * 드래그 중에는 commit=false. A-B가 바뀔 때마다 engine.setLoop을 부르면
     * SimpleFilter가 매번 clear()되어 소리가 튄다. 손을 뗄 때 한 번만 반영한다.
     */
    setSelection(sel, commit = true) {
      set({ selection: sel, activeRegionId: null, loopRegionIds: [] })
      if (commit) syncLoop()
    },

    async saveSelectionAsRegion(label) {
      const { song, selection, beatGrid } = get()
      const title = label.trim()
      if (!song || !selection || !title) return
      const region = await repo.addRegion({
        songId: song.id,
        label: title,
        startSec: selection.startSec,
        endSec: selection.endSec,
        ...(beatGrid ? { beatGrid } : {}),
      })
      const regions = await repo.listRegions(song.id)
      set((state) => state.song?.id === song.id ? {
        regions,
        ...(state.selection === selection ? { activeRegionId: region.id, loopRegionIds: [region.id] } : {}),
      } : state)
    },

    applyRegion(id) {
      const region = get().regions.find((r) => r.id === id)
      if (!region) return
      selectRegion(region, [id])
      syncLoop()
      engine.seekSec(region.startSec)
    },

    toggleLoopRegion(id) {
      const { activeRegionId, loopRegionIds, regions } = get()
      if (!activeRegionId || !regions.some((region) => region.id === id)) return
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
    },

    async renameRegion(id, label) {
      const { song } = get()
      if (!song) return
      await repo.updateRegion(id, { label })
      set({ regions: await repo.listRegions(song.id) })
    },

    async removeRegion(id) {
      const { song } = get()
      if (!song) return
      await repo.removeRegion(id)
      const regions = await repo.listRegions(song.id)
      const state = get()
      if (state.song?.id !== song.id) return
      const included = state.loopRegionIds.includes(id)
      const remaining = state.loopRegionIds.filter((regionId) => regionId !== id)
      set({ regions, loopRegionIds: remaining })
      if (state.activeRegionId === id) {
        const next = regions.find((region) => region.id === remaining[0])
        if (next) selectRegion(next, remaining)
        else set({ activeRegionId: null })
      }
      if (included) syncLoop()
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
      set({ loopEnabled: on })
      syncLoop()
    },

    setSpeed(v) {
      const speed = clamp(Number(v.toFixed(2)), SPEED_MIN, SPEED_MAX)
      engine.setSpeed(speed)
      set({ speed })
    },

    setBeatGrid(grid, commit = true) {
      set({ beatGrid: grid })
      syncMetronome()
      if (!commit) return
      const { activeRegionId, song } = get()
      if (!activeRegionId || !song) return
      // 고른 북마크의 격자를 고친 것 — 그 구간에 저장(화면 목록도 바로 반영)
      set({ regions: get().regions.map((r) => (r.id === activeRegionId ? { ...r, beatGrid: grid ?? undefined } : r)) })
      void repo.updateRegion(activeRegionId, { beatGrid: grid ?? undefined })
    },

    setMetronomeOn(on) {
      set({ metronomeOn: on })
      syncMetronome()
    },

    setMetronomeVolume(v) {
      const metronomeVolume = clamp(v, 0, 1)
      engine.setMetronomeVolume(metronomeVolume)
      set({ metronomeVolume })
    },

    markBeat() {
      if (!engine.isLoaded) return
      const g = get().beatGrid
      set({ beatConfidence: null })
      get().setBeatGrid({
        bpm: g?.bpm ?? DEFAULT_BPM,
        anchorSec: engine.getPositionSec(),
        beatsPerBar: g?.beatsPerBar ?? 4,
      })
    },

    async autoDetectBeat() {
      const { buffer, song, selection, beatDetecting } = get()
      if (!buffer || !song || beatDetecting) return
      const startSec = selection?.startSec ?? 0
      const endSec = selection?.endSec ?? buffer.duration
      set({ beatDetecting: true, status: '박 분석 중…', error: null })
      try {
        const found = await detectBeatGrid(buffer, startSec, endSec)
        if (get().song?.id !== song.id) return // 분석하는 사이 곡을 바꿨다
        if (!found) {
          set({ error: '박을 찾지 못했어요. "첫 박 찍기"로 직접 잡아 주세요.' })
          return
        }
        const bpm = clamp(found.bpm, BPM_MIN, BPM_MAX)
        set({ beatConfidence: found.confidence })
        get().setBeatGrid({ bpm, anchorSec: found.anchorSec, beatsPerBar: get().beatGrid?.beatsPerBar ?? 4 })
        get().setMetronomeOn(true)
      } catch (err) {
        console.error(err)
        if (get().song?.id === song.id) set({ error: '박 분석에 실패했어요.' })
      } finally {
        set({ beatDetecting: false })
        if (get().status === '박 분석 중…') set({ status: null })
      }
    },

    setPitch(v) {
      const pitchSemitones = clamp(Math.round(v), PITCH_MIN, PITCH_MAX)
      engine.setPitchSemitones(pitchSemitones)
      set({ pitchSemitones })
    },

    setVolume(v) {
      const volume = clamp(v, 0, 1)
      engine.setVolume(volume)
      set({ volume })
    },
  }
})
