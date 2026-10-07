-- ============================================================================
-- 보안 강화 마이그레이션 (2026-09)
--
-- 배경: anon 키만으로 아래가 전부 가능했다 (실측 확인).
--   1) app_users 의 pin_hash / pin_salt 통째 SELECT  → 4자리 PIN 오프라인 전수대입
--   2) app_users UPDATE 허용                          → 남의 PIN 교체 · is_admin 자가승격
--   3) admin_list_users 를 익명이 호출                → 회원 명부 전량 덤프
--   4) rooms UPDATE / DELETE 허용                     → 전 코트 위변조 · 삭제
--   5) verify_pin 시도 횟수 제한 없음                 → 온라인 전수대입
--
-- 원인: 클라이언트가 "내가 관리자다 / 내가 이 방 주인이다"를 스스로 주장하는 구조.
--       서버가 호출자를 확인할 수단(세션 토큰)이 없어 모든 권한 검사가 UI 장식이었다.
--
-- 이 마이그레이션이 하는 일:
--   A. 세션 토큰 도입 (로그인 방식·화면은 그대로. 서버가 호출자를 식별할 수 있게 됨)
--   B. app_users / rooms 직접 쓰기를 전면 차단하고 전부 RPC 경유로 전환
--   C. 모든 권한 검사를 서버로 이동
--   D. PIN 온라인 전수대입 차단
--
-- ※ 실행 순서: 이 파일을 SQL Editor 에서 먼저 실행 → 그 다음 index.html 배포.
--   (구 index.html 은 rooms 쓰기가 막혀 실시간 동기화가 멈춘다. 경기 중이 아닐 때 진행할 것)
-- ※ 함수의 search_path 는 'public, extensions' 다. Supabase 는 pgcrypto(digest, gen_random_bytes)를
--   extensions 스키마에 두므로 public 만 두면 실행 시 "function digest(text, unknown) does not exist".
-- ※ 실행 후 기존 로그인 세션은 모두 무효가 된다. 사용자는 한 번 다시 로그인해야 한다.
--   PIN 해시가 이미 공개되어 있었으므로 어차피 전원 PIN 재설정이 필요하다.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- A. 세션 토큰
-- ============================================================================
create table if not exists app_sessions (
  token_hash   text        primary key,              -- sha256(토큰). 원문은 서버에도 남기지 않는다
  user_id      uuid        not null references app_users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '90 days'
);
create index if not exists idx_app_sessions_user on app_sessions (user_id);
create index if not exists idx_app_sessions_exp  on app_sessions (expires_at);

alter table app_sessions enable row level security;   -- 정책을 하나도 만들지 않는다 = 직접 접근 전면 차단
revoke all on app_sessions from anon, authenticated;

-- 토큰 → user_id 해석. 유효하면 만료를 연장한다(사용 중이면 로그아웃되지 않음).
-- 내부 전용: anon 에게 execute 를 주지 않는다.
create or replace function app_auth(p_token text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; th text;
begin
  if p_token is null or length(p_token) < 20 then return null; end if;
  th := encode(digest(p_token, 'sha256'), 'hex');
  select user_id into uid from app_sessions where token_hash = th and expires_at > now();
  if uid is null then return null; end if;
  update app_sessions
     set last_used_at = now(), expires_at = now() + interval '90 days'
   where token_hash = th;
  return uid;
end; $$;
revoke all on function app_auth(text) from anon, authenticated;

-- 토큰 발급 (내부 전용)
create or replace function app_issue_token(p_user_id uuid)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare tok text;
begin
  tok := encode(gen_random_bytes(32), 'hex');
  insert into app_sessions(token_hash, user_id)
    values (encode(digest(tok, 'sha256'), 'hex'), p_user_id);
  -- 같은 사용자의 만료된 세션 정리
  delete from app_sessions where user_id = p_user_id and expires_at <= now();
  return tok;
end; $$;
revoke all on function app_issue_token(uuid) from anon, authenticated;

-- 관리자 확인 (내부 전용)
create or replace function app_require_admin(p_token text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid;
begin
  uid := app_auth(p_token);
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not exists (select 1 from app_users where id = uid and coalesce(is_admin,false)) then
    raise exception 'FORBIDDEN';
  end if;
  return uid;
end; $$;
revoke all on function app_require_admin(text) from anon, authenticated;

-- ============================================================================
-- B. PIN 온라인 전수대입 차단
--    잠금이 아니라 "짧은 냉각"이다. 정상 사용자는 사실상 만나지 않는다.
-- ============================================================================
alter table app_users add column if not exists failed_pin_count int         not null default 0;
alter table app_users add column if not exists pin_locked_until  timestamptz;

-- ============================================================================
-- C. 인증 RPC (토큰 반환하도록 교체)
-- ============================================================================

-- 로그인. 성공하면 { id, nickname, is_admin, token } 을 돌려준다.
create or replace function verify_pin(p_nickname text, p_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare u record; computed_hash text; tok text;
begin
  select id, pin_hash, pin_salt, coalesce(is_admin,false) as is_admin,
         failed_pin_count, pin_locked_until
    into u from app_users where nickname = p_nickname;

  -- 존재하지 않는 닉네임도 동일하게 null 을 돌려준다 (계정 존재 여부를 흘리지 않는다)
  if not found then return null; end if;

  if u.pin_locked_until is not null and u.pin_locked_until > now() then
    raise exception 'PIN_COOLDOWN';
  end if;

  computed_hash := encode(digest(p_pin || ':' || u.pin_salt, 'sha256'), 'hex');

  if computed_hash <> u.pin_hash then
    update app_users
       set failed_pin_count = failed_pin_count + 1,
           -- 10회 연속 실패 시 10분 냉각 (4자리 PIN 전수대입 1만 회를 실질적으로 차단)
           pin_locked_until = case when failed_pin_count + 1 >= 10
                                   then now() + interval '10 minutes' else pin_locked_until end
     where id = u.id;
    return null;
  end if;

  update app_users
     set last_seen_at = now(), failed_pin_count = 0, pin_locked_until = null
   where id = u.id;

  tok := app_issue_token(u.id);
  return json_build_object('id', u.id, 'nickname', p_nickname,
                           'is_admin', u.is_admin, 'token', tok);
end; $$;

-- 회원가입. 가입 즉시 로그인 상태가 되도록 토큰을 함께 돌려준다 (기존 동작과 동일).
create or replace function create_account(p_nickname text, p_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare new_salt text; new_hash text; new_id uuid; tok text;
begin
  if p_pin !~ '^[0-9]{4}$' then raise exception 'PIN_INVALID'; end if;
  if length(p_nickname) < 2 or length(p_nickname) > 20 then raise exception 'NICKNAME_INVALID'; end if;
  new_salt := encode(gen_random_bytes(16), 'hex');
  new_hash := encode(digest(p_pin || ':' || new_salt, 'sha256'), 'hex');
  insert into app_users(nickname, pin_hash, pin_salt) values (p_nickname, new_hash, new_salt)
    returning id into new_id;
  tok := app_issue_token(new_id);
  return json_build_object('id', new_id, 'nickname', p_nickname, 'is_admin', false, 'token', tok);
exception when unique_violation then raise exception 'NICKNAME_TAKEN'; end; $$;

-- PIN 변경. user_id 를 클라이언트가 주장하던 것을 토큰 기반으로 바꾼다.
drop function if exists change_pin(uuid, text, text);
create or replace function change_pin(p_token text, p_cur_pin text, p_new_pin text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; u record; cur_hash text; new_salt text; new_hash text;
begin
  uid := app_auth(p_token);
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_new_pin !~ '^[0-9]{4}$' then raise exception 'PIN_INVALID'; end if;
  select pin_hash, pin_salt into u from app_users where id = uid;
  if not found then raise exception 'NOT_FOUND'; end if;
  cur_hash := encode(digest(p_cur_pin || ':' || u.pin_salt, 'sha256'), 'hex');
  if cur_hash <> u.pin_hash then raise exception 'PIN_MISMATCH'; end if;
  new_salt := encode(gen_random_bytes(16), 'hex');
  new_hash := encode(digest(p_new_pin || ':' || new_salt, 'sha256'), 'hex');
  update app_users set pin_hash = new_hash, pin_salt = new_salt where id = uid;
  -- PIN 이 바뀌면 다른 기기의 세션은 끊는다
  delete from app_sessions where user_id = uid;
  return json_build_object('ok', true);
end; $$;

-- 앱 부팅 시 "내가 누구인지" 재확인. app_users 직접 조회를 대체한다.
create or replace function me(p_token text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; u record;
begin
  uid := app_auth(p_token);
  if uid is null then return null; end if;
  select id, nickname, coalesce(is_admin,false) as is_admin into u from app_users where id = uid;
  if not found then return null; end if;
  return json_build_object('id', u.id, 'nickname', u.nickname, 'is_admin', u.is_admin);
end; $$;

-- 로그아웃 — 이 기기의 세션만 지운다
create or replace function sign_out(p_token text)
returns json language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_token is not null then
    delete from app_sessions where token_hash = encode(digest(p_token,'sha256'),'hex');
  end if;
  return json_build_object('ok', true);
end; $$;

grant execute on function verify_pin(text, text)            to anon, authenticated;
grant execute on function create_account(text, text)        to anon, authenticated;
grant execute on function change_pin(text, text, text)      to anon, authenticated;
grant execute on function me(text)                          to anon, authenticated;
grant execute on function sign_out(text)                    to anon, authenticated;

-- ============================================================================
-- D. app_users 를 anon 으로부터 완전 차단
--    (RPC 는 SECURITY DEFINER 라 계속 동작한다)
-- ============================================================================
drop policy if exists "read app_users"   on app_users;
drop policy if exists "insert app_users" on app_users;
drop policy if exists "update app_users" on app_users;
revoke all on app_users        from anon, authenticated;
revoke all on app_users_public from anon, authenticated;   -- 뷰도 함께 닫는다. 앱은 me()/RPC 만 쓴다

-- ============================================================================
-- E. rooms — 직접 쓰기 차단, 전부 RPC 경유
-- ============================================================================

-- 코드 형식 고정. 이걸로 방 코드를 통한 HTML 주입 자체가 불가능해진다.
-- (기존에 형식을 벗어난 코드가 있으면 먼저 정리해야 한다)
delete from rooms where code !~ '^[A-Z0-9]{6}$';
alter table rooms drop constraint if exists rooms_code_fmt;
alter table rooms add constraint rooms_code_fmt check (code ~ '^[A-Z0-9]{6}$');

-- 마지막으로 쓴 클라이언트. Realtime 에코를 시각(500ms)이 아니라 신원으로 구분한다.
alter table rooms add column if not exists last_writer text;

-- 방 만들기 — 코드는 서버가 생성하고 중복 시 재시도한다. owner_id 는 토큰에서 온다.
create or replace function room_create(p_token text, p_title text, p_state jsonb)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; new_code text; chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; i int; k int;
begin
  uid := app_auth(p_token);
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  for k in 1..20 loop
    new_code := '';
    for i in 1..6 loop
      new_code := new_code || substr(chars, 1 + floor(random()*length(chars))::int, 1);
    end loop;
    begin
      insert into rooms(code, owner_id, title, state, is_open, last_writer)
        values (new_code, uid, coalesce(left(p_title,60),''), p_state, true, null);
      return json_build_object('code', new_code);
    exception when unique_violation then
      -- 코드 충돌 → 다시 뽑는다
    end;
  end loop;
  raise exception 'CODE_COLLISION';
end; $$;

-- 방 상태 push. 낙관적 락 포함.
--   p_base_updated_at 이 서버의 현재 updated_at 보다 과거면 = 내가 읽은 뒤 남이 썼다는 뜻.
--   그때는 쓰지 않고 최신 상태를 돌려준다 (클라이언트가 병합 후 재시도).
create or replace function room_push_state(p_token text, p_code text, p_state jsonb,
                                           p_client_id text, p_base_updated_at timestamptz)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; cur record; newts timestamptz;
begin
  uid := app_auth(p_token);
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select state, updated_at, is_open into cur from rooms where code = p_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not cur.is_open then raise exception 'ROOM_CLOSED'; end if;
  if p_base_updated_at is not null and cur.updated_at > p_base_updated_at then
    return json_build_object('ok', false, 'conflict', true,
                             'state', cur.state, 'updated_at', cur.updated_at);
  end if;
  update rooms set state = p_state, last_writer = p_client_id where code = p_code
    returning updated_at into newts;
  return json_build_object('ok', true, 'updated_at', newts);
end; $$;

-- 방 접속 — is_open 인 방만 연다 (종료된 코트는 이력으로만 본다는 원래 규칙 복원)
create or replace function room_get(p_code text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare r record;
begin
  select code, title, owner_id, state, is_open, updated_at into r from rooms where code = p_code;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not r.is_open then raise exception 'ROOM_CLOSED'; end if;
  return json_build_object('code', r.code, 'title', r.title, 'owner_id', r.owner_id,
                           'state', r.state, 'updated_at', r.updated_at);
end; $$;

-- 코트 종료 (주인만)
create or replace function room_close(p_token text, p_code text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; own uuid;
begin
  uid := app_auth(p_token);
  if uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select owner_id into own from rooms where code = p_code;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if own is distinct from uid then raise exception 'NOT_OWNER'; end if;
  update rooms set is_open = false where code = p_code;
  return json_build_object('ok', true);
end; $$;

grant execute on function room_create(text, text, jsonb)                              to anon, authenticated;
grant execute on function room_push_state(text, text, jsonb, text, timestamptz)       to anon, authenticated;
grant execute on function room_get(text)                                              to anon, authenticated;
grant execute on function room_close(text, text)                                      to anon, authenticated;

-- 직접 쓰기 차단. SELECT 는 남긴다 — "열려있는 코트 목록"은 이 앱의 존재 이유다.
drop policy if exists "insert rooms" on rooms;
drop policy if exists "update rooms" on rooms;
drop policy if exists "delete rooms" on rooms;
revoke insert, update, delete on rooms from anon, authenticated;

-- ============================================================================
-- F. 관리자 RPC — 전부 토큰 기반 권한 검사
-- ============================================================================
drop function if exists admin_list_users(text, int, int);
create or replace function admin_list_users(p_token text, p_search text,
                                            p_limit int default 50, p_offset int default 0)
returns table(id uuid, nickname text, is_admin boolean,
              created_at timestamptz, last_seen_at timestamptz, total_count bigint)
language plpgsql security definer set search_path = public, extensions as $$
declare q text;
begin
  perform app_require_admin(p_token);
  q := coalesce('%' || lower(p_search) || '%', '%%');
  return query
    with matched as (
      select u.id, u.nickname, coalesce(u.is_admin,false) as is_admin, u.created_at, u.last_seen_at
        from app_users u where lower(u.nickname) like q order by u.created_at desc
    ), counted as (select count(*) from matched)
    select m.*, (select * from counted) as total_count from matched m
     limit greatest(1, least(coalesce(p_limit,50), 200)) offset greatest(0, coalesce(p_offset,0));
end; $$;

-- 관리자 코트 목록 — 코트주 닉네임까지 서버에서 조인해 돌려준다
-- (기존 클라이언트는 app_users 를 직접 조회했는데, 이제 그 경로가 막힌다)
create or replace function admin_list_rooms(p_token text)
returns table(code text, title text, owner_id uuid, owner_nickname text,
              is_open boolean, created_at timestamptz, updated_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform app_require_admin(p_token);
  return query
    select r.code, r.title, r.owner_id, u.nickname, r.is_open, r.created_at, r.updated_at
      from rooms r left join app_users u on u.id = r.owner_id
     order by r.created_at desc limit 200;
end; $$;

create or replace function admin_close_room(p_token text, p_code text)
returns json language plpgsql security definer set search_path = public, extensions as $$
begin
  perform app_require_admin(p_token);
  update rooms set is_open = false where code = p_code;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  return json_build_object('ok', true);
end; $$;

create or replace function admin_delete_room(p_token text, p_code text)
returns json language plpgsql security definer set search_path = public, extensions as $$
begin
  perform app_require_admin(p_token);
  delete from rooms where code = p_code;
  return json_build_object('ok', true);
end; $$;

grant execute on function admin_list_users(text, text, int, int) to anon, authenticated;
grant execute on function admin_list_rooms(text)                 to anon, authenticated;
grant execute on function admin_close_room(text, text)           to anon, authenticated;
grant execute on function admin_delete_room(text, text)          to anon, authenticated;

-- ============================================================================
-- G. 확인용 — 아래는 전부 실패(401/403/permission denied)해야 한다
-- ============================================================================
--   GET  /rest/v1/app_users?select=pin_hash
--   PATCH /rest/v1/app_users?id=eq.<uuid>  {"is_admin":true}
--   POST /rest/v1/rpc/admin_list_users  {"p_search":null}      -- 토큰 없음 → FORBIDDEN
--   DELETE /rest/v1/rooms?code=eq.XXXXXX
--   PATCH  /rest/v1/rooms?code=eq.XXXXXX  {"state":{}}
