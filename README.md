# 도돌이 (dodori) — M1

mp3를 브라우저에서 열어 파형 위에서 A-B 구간을 잡고, 그 구간만 반복하며 연습하는 도구.
설계 문서: [dodori-design.html](dodori-design.html)

**M1 범위** — 서버 없이 브라우저 안에서만 동작한다. 파일은 업로드되지 않고 IndexedDB에 남는다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173
```

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 |
| `npm run build` | 타입 검사 + 프로덕션 번들 |
| `npm test` | 루프 소스 · 파형 열 계산 · 메트로놈 · 자동 박 감지 단위 테스트 (Node 22+ 필요) |
| `npm run test:e2e` | 실제 Chrome을 몰아서 전 과정 확인 (`npm run dev` 실행 중이어야 함) |

`npm run test:e2e`는 8초짜리 테스트 음원을 만들어 파일 입력에 넣고, 파형 렌더 → 드래그로
A-B 선택 → 구간 저장 → 스페이스바 재생 → 새로고침 후 복원까지 17가지를 확인한다.
브라우저를 눈으로 보려면 `HEADED=1 npm run test:e2e`.

## 지금 되는 것

- mp3 열기(파일 선택 · 드래그 앤 드롭) → 파형 표시
- 위쪽 시간 눈금을 드래그해 A-B 구간 지정, 경계선을 잡아 미세 조정
- 휠 · 트랙패드 핀치로 확대/축소, 파형 드래그 · 가로 스크롤로 좌우 이동
- **이음새 없는 구간 반복**, 속도 0.5–1.25×(음정 유지), 키 ±6반음
- 구간 북마크 저장 · 클릭 한 번에 그 루프로 진입
- 북마크를 고른 뒤 다른 북마크의 `+ 반복`을 누르면 함께 반복한다.
  겹치는 구간은 합쳐서 한 번만 재생하고, 떨어진 구간 사이는 건너뛴다.
- 곡 · 구간 · 파형 캐시 IndexedDB 저장, 마지막 곡 자동 복원
- 메트로놈: 곡에 붙은 박자 격자(BPM · 첫 박 · 박자), 속도를 바꿔도 박을 따라감
- 박자 격자를 수정하려면 **박자 편집**을 켠다. 편집 중에만 파형의 박자 선과 BPM·첫 박·박자를 조정할 수 있다.
  **박자 편집 완료**로 적용하고, **편집 취소** 또는 `Esc`로 편집 시작 전 값으로 돌아간다.
- **자동 박 감지**: "자동"을 누르면 고른 구간(없으면 곡 전체)에서 BPM과 첫 박을 찾는다.
  빠르기가 두 배·절반으로 잡히면 `×2`·`÷2`, 강박 자리가 다르면 `강박 →`로 고친다
- 단축키: `Space` 재생/정지, `L` 구간 반복 토글, `T` 첫 박 찍기(박자 편집 중), `M` 메트로놈

## 구조

```
src/
  audio/
    loopSource.ts   ← 루프 정밀도의 핵심. 읽기 위치를 A-B 안으로 감는다
    metronome.ts    ← 클릭 믹서. 출력 단에서 곡 시간축의 박에 맞춰 클릭을 섞는다
    beatDetect.ts   ← 자동 박 감지(격자 맞추기 · 어택 정렬). Essentia 호출은 워커에서
    beatDetect.worker.ts ← Essentia(WASM)를 여기서만 불러온다 — 버튼을 누를 때 따로 내려받음
    engine.ts       ← 신호 그래프 · 트랜스포트 · 재생 위치 추정
    peaks.ts        ← 파형 피크(캐시해서 재계산 방지)
    hash.ts         ← 파일 내용 해시(중복 방지, M3 기기 간 곡 식별)
  db/
    db.ts           ← Dexie 스키마
    repo.ts         ← 저장소 경계. M3에서 Supabase를 붙일 때 바꿀 지점
  store/usePlayer.ts
  components/       ← Library · Transport · Waveform · DrillPanel · RegionList
```

### 루프가 매끄러운 이유

`<audio>`의 `timeupdate`로 되감으면 이음새에 수십 ms 틈이 생긴다. 여기서는 mp3를
`AudioBuffer`로 디코딩한 뒤, SoundTouch가 샘플을 당겨갈 때 읽기 인덱스를 A-B 안으로
감아버린다([loopSource.ts](src/audio/loopSource.ts)). SoundTouch 입장에서는 끊긴 적 없는
하나의 연속 스트림이라, 이음새가 오버랩-애드 안에서 자연스럽게 섞인다.

## 알려진 한계 (M2 이후)

- 속도·피치 처리에 `ScriptProcessorNode`를 쓴다(soundtouchjs 기본 경로). deprecated이고
  메인 스레드에서 돌아, 무거운 작업과 겹치면 끊길 수 있다. → AudioWorklet으로 교체 가능한
  자리로 격리해 두었다.
- 재생 위치 표시는 파이프라인 지연을 상수로 보정한 **추정치**다(±100ms 안팎).
- 속도 1.0×에서도 SoundTouch를 통과한다. 원음 그대로가 필요하면 우회 경로가 필요하다.
- 반복 횟수 · 반복 간격 · 점진적 속도 · 카운트인은 M2.
- 자동 박 감지는 템포가 일정하다고 가정한다. 템포가 흔들리는 곡은 구간을 잡고 그 구간만
  분석하는 편이 정확하다. 강박(마디의 1박)은 추정하지 않는다 — 구간 시작 뒤 첫 박이 1박.

### 자동 박 감지가 하는 일

[Essentia](https://essentia.upf.edu/) `RhythmExtractor2013`(multifeature)으로 박 위치를 얻고,
그 박들에 등간격 격자를 최소제곱으로 맞춘다(수렴 전 박 · 엇박은 이상치로 제외). Essentia의 박은
분석 hop(≈11.6ms) 단위이고 실제 어택보다 10–20ms 이르게 나오므로, 박마다 원본 신호에서 1ms
해상도로 가장 가까운 어택을 찾아 격자를 다시 맞춘다. 합성 음원 기준 BPM 오차 0.01 이하,
첫 박 오차 1ms 안쪽([tests/beatDetect.test.ts](tests/beatDetect.test.ts)).

## 라이선스

[GNU AGPL-3.0](LICENSE) (또는 이후 버전). 자동 박 감지에 AGPL-3.0인
[essentia.js](https://github.com/MTG/essentia.js)(© Music Technology Group, Universitat Pompeu
Fabra)를 쓰기 때문에, 이 앱을 배포하거나 네트워크로 제공할 때는 수정본을 포함한 전체 소스를
같은 조건으로 공개해야 한다. 앱 상단의 "소스" 링크가 그 소스를 가리킨다.
