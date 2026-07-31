# CLAUDE.md

이 파일은 이 리포에서 작업하는 Claude(또는 사람)를 위한 안내다. 처음 이 리포를 만졌다면 이걸 먼저 읽는다.

## 무엇인가

동호회 테니스 **대진 생성 · 결과 집계 앱**. 배포: https://donghakim-hr.github.io/tennis/

- **`index.html` 한 파일이 앱 전체다.** HTML + `<style>` + `<script>` 인라인, 약 97KB.
- **외부 라이브러리·프레임워크·빌드 과정·서버가 없다.** 파일을 브라우저로 열면 그대로 돈다.
- GitHub Pages가 `main` 브랜치 루트를 그대로 서빙한다. `index.html`을 push하면 그게 배포다.
- 상세 사양은 [`tennis-match-spec.md`](tennis-match-spec.md). **동작을 바꾸면 사양서도 같이 고친다.**

## 이 제약을 지켜라

1. **의존성 추가 금지** — npm 패키지, CDN 스크립트, 웹폰트 모두 안 된다. `package.json`의 jsdom은 **테스트 전용**이며 앱은 그것을 모른다.
2. **파일을 쪼개지 말 것** — 총무가 파일 하나를 카톡으로 주고받거나 로컬에서 열어 쓰는 것이 사용 방식이다.
3. **ES5 스타일 유지** — 기존 코드가 `var`, `function`, `Array.prototype.forEach.call` 스타일이다. 오래된 기기(코트장의 낡은 폰)를 상정한다. 새 코드도 그 문체를 따른다.
4. **색은 CSS 변수로** — `--court --ink --muted --hair --bg --card --ball --win`. 새 hex를 늘리기 전에 기존 토큰이나 `.warnbox` 팔레트(`#8f2f2f`/`#f3c9c9`/`#fdecec`)를 재사용한다.
5. **한국어 UI** — 모든 문구는 한국어. 주석도 한국어로 통일되어 있다.

## 코드 지도 (`index.html`)

| 구간 | 내용 |
|---|---|
| `<style>` | `:root` 토큰 → 공통 → 헤더/탭 → 설정 카드 → 코트 카드 → 표 → 기록 → 저장 바 |
| 마크업 | `header`(탭) → `#intro`(종목 선택) → `#setup`(설정 카드 8장) → `#sched/#summary/#rank/#hist` → `footer` → `#setupbar`/`#savebar`/`#toast` |
| JS: 저장 | `Store` — `window.storage` → `localStorage` → 메모리 순으로 폴백 |
| JS: 상태 | `S`(현재 세션) · `DB.sessions[날짜]`(기록) · `snapshot()`/`hydrate()` |
| JS: 알고리즘 | `attempt()`(일반) · `attemptFixed()`(고정 조) · `buildSchedule()` · 비용 상수 `W_PAIR/W_OPPO/W_BAL` |
| JS: 공유 | `encodeShare()`/`decodeShare()`/`shareUrl()` — URL 해시 `#v1=` |
| JS: 렌더 | `renderIntro/renderSetup/renderSchedule/renderSummary/renderRank/renderHistory/renderSaveBar` + `render()`가 전체 전환 |
| JS: 접기 | `FOLD_KEYS`/`foldClosed`/`paintFold()`/`refreshFold()` |

## 반드시 알아야 할 함정

### 1. `[hidden]`은 저절로 숨지 않는다
`.setup{display:grid}` 같은 **저자 선언이 UA의 `[hidden]{display:none}`을 캐스케이드에서 이긴다**(Chrome·Safari). 그래서 CSS 맨 위에 이 줄이 있다.

```css
[hidden]{display:none!important}
```

**이 줄을 지우면 화면 전환이 전부 깨진다.** 실제로 이 버그로 첫 화면에 설정 폼 853px이 남아 있었다(사양서 9-1).

### 2. jsdom은 캐스케이드를 정확히 흉내내지 않는다
jsdom은 위 문제를 **재현하지 못한다**(`display:none`으로 계산해버린다). 그래서 시각·레이아웃 문제는 **반드시 실제 브라우저**로 확인한다. jsdom은 상태·동작 검증용이다.

### 3. 로컬 파일은 브라우저 도구로 조작이 안 될 수 있다
Claude Code의 Browser pane은 프로젝트 밖 `file://`을 정적 스냅샷으로만 렌더하고(스크립트 미실행), `127.0.0.1`은 정책상 막힐 수 있다. **실제 브라우저 검증은 배포본 URL로 한다** — push 후 `?v=2` 같은 쿼리로 캐시를 우회하고, `javascript_tool`로 `getComputedStyle`·`getBoundingClientRect`를 직접 재는 방식이 확실하다.

### 4. 점수 입력 중에는 전체 재렌더를 하지 않는다
`#sched`의 input 핸들러는 포커스를 지키기 위해 `render()`를 부르지 않고 필요한 부분만 갱신한다. 여기에 새 UI를 넣으면 **그 갱신 로직도 같이 넣어야 한다**(라운드 진행도 배지가 그 예).

### 5. 대진 알고리즘의 우선순위를 바꾸지 말 것
비용 가중치는 `페어 중복 40 > 상대 중복 4`, 등급 균형은 `12/점`이다. 등급 가중치를 40 이상으로 올리면 **중복 회피가 깨진다**. 사양서 3-2 참조.

### 6. 공유 링크 포맷
`#v1=base64url(설정~이름~대진·점수)`이고 구획 구분자는 **개행**이다(`~`는 필드 구분자라 빈 값이 섞이면 충돌한다 — 실제로 그 버그가 있었다). 포맷을 바꾸면 `v1`을 올리고 이전 링크 처리를 정한다.

## 개발 흐름

```bash
git clone https://github.com/donghakim-hr/tennis.git
cd tennis
npm install          # 테스트용 jsdom만 설치
npm test             # 전체 (약 1~2분)
```

> **Node 22.22.2 이상이 필요하다.** jsdom 30이 그 아래에서는 설치는 되지만(경고만) 실행 중 죽는다.
> CI도 이 때문에 한 번 실패했다. `package.json`의 `engines`와 워크플로의 `node-version`을 같이 맞춘다.

| 명령 | 내용 |
|---|---|
| `npm test` | 알고리즘 700조합 + 기능 + UI/UX 전체 |
| `npm run test:algorithm` | 대진 보장 사항 (라운드·코트·목표 경기·편차·팀 구성·1라운드 고정) |
| `npm run test:features` | 고정 조 · 등급 · 공유 링크 왕복 · 깨진 링크 |
| `npm run test:ux` | 접기·점수 입력·탭·코트 수·명단 불러오기·열람 보호 |
| `npm run contrast` | `:root` 토큰을 읽어 WCAG 대비비 검사 (**색을 바꾸면 먼저 이걸 돌린다**) |
| `npm run balance` | 등급이 팀 전력 편차를 실제로 줄이는지 측정 |

`.github/workflows/test.yml`이 push·PR마다 같은 것을 돌린다.

### 화면을 눈으로 확인하려면
브라우저로 `index.html`을 직접 열면 된다(서버 불필요). 모바일 확인은 배포 후 폰에서 열거나 개발자도구 기기 모드를 쓴다.

## 변경할 때의 체크리스트

- [ ] `npm test` 통과 (실패하면 원인을 고친다 — 테스트를 느슨하게 만들지 않는다)
- [ ] 색을 건드렸으면 `npm run contrast` 통과
- [ ] 새 터치 대상은 44×44 이상
- [ ] 동작이 바뀌었으면 `tennis-match-spec.md` 갱신
- [ ] 새 기능이면 `tests/`에 검사 추가
- [ ] 실제 브라우저(배포본)에서 눈으로 확인 — 특히 화면 전환·고정 요소·모바일 폭

## 남은 일

[`BACKLOG.md`](BACKLOG.md)에 후보와 **의도적으로 하지 않기로 한 것**이 정리되어 있다. 새 기능을 제안하기 전에 그 '하지 말 것' 목록을 확인한다.
