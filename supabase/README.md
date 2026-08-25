# Supabase 셋업 가이드

이 앱은 **로그인·방·이력** 기능이 Supabase(BaaS)를 사용한다. 아래 절차대로 프로젝트를 만들고 키를 앱에 넣는다.

## 1. 프로젝트 생성

1. https://supabase.com 접속 → 로그인 → **New project** 클릭
2. Organization 선택, Project name 입력 (예: `tennis-match`)
3. Database Password는 아무거나 (앱에서는 안 씀, 관리자용)
4. Region: **Northeast Asia (Seoul)** 선택
5. **Create new project** — 약 2분 소요

## 2. 스키마 실행

1. 프로젝트 대시보드 → 왼쪽 메뉴 **SQL Editor** 클릭
2. **+ New query**
3. 이 폴더의 [`schema.sql`](./schema.sql) 전체를 복사해 붙여넣기
4. **Run** (또는 Cmd+Enter)
5. 하단에 "Success. No rows returned" 나오면 완료

## 3. Realtime 활성화

1. 왼쪽 메뉴 **Database** → **Replication**
2. `supabase_realtime` publication → `rooms` 테이블 토글 켜기

## 4. 앱에 키 넣기

1. 왼쪽 메뉴 **Project Settings** → **API**
2. 아래 두 값을 복사:
   - **Project URL** (예: `https://xxxx.supabase.co`)
   - **anon public** 키 (매우 긴 문자열)
3. `index.html` 상단의 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 상수에 붙여넣기

```javascript
// index.html 상단
var SUPABASE_URL      = "https://xxxx.supabase.co";
var SUPABASE_ANON_KEY = "eyJhbGciOi...";
```

## 5. 확인

`index.html`을 브라우저에 열면 우상단에 **로그인** 버튼이 뜬다. 닉네임(자유) + 4자리 PIN으로 계정을 만들면 끝.

---

## 사용 데이터

| 저장 항목 | 위치 |
|---|---|
| 닉네임·PIN 해시 | `app_users` 테이블 |
| 방 상태 (대진·점수) | `rooms.state` (JSONB) |
| 완료 세션 이력 | `sessions`, `user_sessions` |
| 오프라인 백업 | 브라우저 localStorage |

## 개인정보

- **저장 안 함**: 이메일, 실명, 전화, IP
- **저장함**: 사용자가 입력한 닉네임과 PIN 해시(SHA-256 + salt)

## 무료 티어 한도

Supabase 무료 계정 기준:
- DB 500MB (동호회 규모라면 수년 사용 가능)
- 월 2GB 대역폭
- 동시 접속 200
- 프로젝트 1주 미사용시 자동 일시정지 (재접속하면 몇 초 뒤 복구)
