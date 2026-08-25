-- 테니스 매칭 앱 Supabase 스키마
-- Supabase 프로젝트 대시보드 → SQL Editor 에서 실행한다.

-- ============================================================================
-- 1. 계정 (닉네임 + 4자리 PIN)
-- ============================================================================
create table if not exists app_users (
  id           uuid        primary key default gen_random_uuid(),
  nickname     text        not null unique,
  pin_hash     text        not null,                         -- SHA-256 + salt
  pin_salt     text        not null,
  is_admin     boolean     not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
-- 기존 사용자를 위한 안전한 컬럼 추가 (schema.sql 재실행 시)
alter table app_users add column if not exists is_admin boolean not null default false;

create index if not exists idx_app_users_nickname on app_users (nickname);

-- ============================================================================
-- 2. 방 (누구나 방 코드로 접속 가능)
-- ============================================================================
create table if not exists rooms (
  code         text        primary key,                      -- 6자 코드 예: 'K3M7X2'
  owner_id     uuid        references app_users(id) on delete set null,
  title        text        not null default '',              -- 방 제목 (선택)
  state        jsonb       not null,                         -- 대진표 전체 스냅샷 (S 객체)
  is_open      boolean     not null default true,            -- true면 열려있어 접속 가능
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_rooms_open on rooms (is_open, updated_at desc);
create index if not exists idx_rooms_updated on rooms (updated_at desc);

-- 실시간 구독을 위해 rooms 테이블에 replica identity 설정
alter table rooms replica identity full;

-- ============================================================================
-- 3. 세션 (완료된 게임 이력)
-- ============================================================================
create table if not exists sessions (
  id           uuid        primary key default gen_random_uuid(),
  room_code    text        references rooms(code) on delete set null,
  played_on    date        not null,
  snapshot     jsonb       not null,                         -- 대진·점수 최종 스냅샷
  created_at   timestamptz not null default now()
);

create index if not exists idx_sessions_played_on on sessions (played_on desc);

-- ============================================================================
-- 4. 세션 참여자 (누가 어떤 세션에 참여했는지)
-- ============================================================================
create table if not exists user_sessions (
  user_id     uuid not null references app_users(id) on delete cascade,
  session_id  uuid not null references sessions(id) on delete cascade,
  player_name text not null,                                 -- 세션 내 표기명
  primary key (user_id, session_id)
);

create index if not exists idx_user_sessions_user on user_sessions (user_id);

-- ============================================================================
-- 5. updated_at 자동 갱신 트리거
-- ============================================================================
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists rooms_updated_at on rooms;
create trigger rooms_updated_at
  before update on rooms
  for each row execute function set_updated_at();

-- ============================================================================
-- 6. RLS (Row Level Security)
-- 익명 접근이 필요한 hobby app이라 열어두되, 파괴적 작업은 최소화
-- ============================================================================
alter table app_users     enable row level security;
alter table rooms         enable row level security;
alter table sessions      enable row level security;
alter table user_sessions enable row level security;

-- 누구나 읽기 가능 (닉네임 중복 확인, 방 목록 조회 등)
create policy "read app_users"  on app_users     for select using (true);
create policy "read rooms"      on rooms         for select using (true);
create policy "read sessions"   on sessions      for select using (true);
create policy "read user_sess"  on user_sessions for select using (true);

-- 누구나 생성 가능 (회원가입, 방 만들기)
create policy "insert app_users" on app_users     for insert with check (true);
create policy "insert rooms"     on rooms         for insert with check (true);
create policy "insert sessions"  on sessions      for insert with check (true);
create policy "insert user_sess" on user_sessions for insert with check (true);

-- 누구나 수정 가능 (열린 방은 누구나 편집)
create policy "update rooms"    on rooms      for update using (true) with check (true);
create policy "update app_users" on app_users for update using (true) with check (true);

-- ============================================================================
-- 7. Realtime 활성화
-- Dashboard → Database → Replication 에서 rooms 테이블 Realtime 켜기
-- 혹은 아래 SQL 실행:
-- ============================================================================
-- alter publication supabase_realtime add table rooms;
