-- 5천명 규모 대비 · 보안 강화 마이그레이션
-- Supabase SQL Editor에서 실행한다.

-- ============================================================================
-- 1. pgcrypto (서버측 해시)
-- ============================================================================
create extension if not exists pgcrypto;

-- ============================================================================
-- 2. RPC: verify_pin (로그인)
-- 클라이언트가 raw PIN 을 넘기면 서버에서 hash 비교. pin_hash/salt 는 절대 나가지 않음.
-- ============================================================================
create or replace function verify_pin(p_nickname text, p_pin text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  u record;
  computed_hash text;
begin
  select id, pin_hash, pin_salt, coalesce(is_admin, false) as is_admin
    into u
    from app_users
    where nickname = p_nickname;
  if not found then return null; end if;
  computed_hash := encode(digest(p_pin || ':' || u.pin_salt, 'sha256'), 'hex');
  if computed_hash <> u.pin_hash then return null; end if;
  update app_users set last_seen_at = now() where id = u.id;
  return json_build_object('id', u.id, 'nickname', p_nickname, 'is_admin', u.is_admin);
end;
$$;

grant execute on function verify_pin(text, text) to anon, authenticated;

-- ============================================================================
-- 3. RPC: create_account (회원가입)
-- ============================================================================
create or replace function create_account(p_nickname text, p_pin text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  new_salt text;
  new_hash text;
  new_id   uuid;
begin
  if p_pin !~ '^[0-9]{4}$' then raise exception 'PIN_INVALID' using errcode = 'P0001'; end if;
  if length(p_nickname) < 2 or length(p_nickname) > 20 then
    raise exception 'NICKNAME_INVALID' using errcode = 'P0001';
  end if;
  new_salt := encode(gen_random_bytes(16), 'hex');
  new_hash := encode(digest(p_pin || ':' || new_salt, 'sha256'), 'hex');
  insert into app_users(nickname, pin_hash, pin_salt)
    values (p_nickname, new_hash, new_salt)
    returning id into new_id;
  return json_build_object('id', new_id, 'nickname', p_nickname, 'is_admin', false);
exception
  when unique_violation then
    raise exception 'NICKNAME_TAKEN' using errcode = 'P0001';
end;
$$;

grant execute on function create_account(text, text) to anon, authenticated;

-- ============================================================================
-- 4. RPC: change_pin (PIN 변경)
-- ============================================================================
create or replace function change_pin(p_user_id uuid, p_cur_pin text, p_new_pin text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  u record;
  cur_hash text;
  new_salt text;
  new_hash text;
begin
  if p_new_pin !~ '^[0-9]{4}$' then raise exception 'PIN_INVALID' using errcode = 'P0001'; end if;
  select pin_hash, pin_salt into u from app_users where id = p_user_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0001'; end if;
  cur_hash := encode(digest(p_cur_pin || ':' || u.pin_salt, 'sha256'), 'hex');
  if cur_hash <> u.pin_hash then raise exception 'PIN_MISMATCH' using errcode = 'P0001'; end if;
  new_salt := encode(gen_random_bytes(16), 'hex');
  new_hash := encode(digest(p_new_pin || ':' || new_salt, 'sha256'), 'hex');
  update app_users set pin_hash = new_hash, pin_salt = new_salt where id = p_user_id;
  return json_build_object('ok', true);
end;
$$;

grant execute on function change_pin(uuid, text, text) to anon, authenticated;

-- ============================================================================
-- 5. 안전 컬럼만 노출하는 공용 뷰 (pin_hash/pin_salt 제외)
-- ============================================================================
create or replace view app_users_public as
  select id, nickname, coalesce(is_admin, false) as is_admin, created_at, last_seen_at
    from app_users;

grant select on app_users_public to anon, authenticated;

-- ============================================================================
-- 6. app_users 직접 SELECT 회수 (누구나 pin_hash 덤프 방지)
-- 앱은 이제부터 app_users_public (읽기) + RPC (인증/변경) 만 사용한다.
-- last_seen_at 갱신도 verify_pin RPC 안에서 처리.
-- ============================================================================
revoke select on app_users from anon, authenticated;
-- INSERT/UPDATE 도 RPC 통해서만 (SECURITY DEFINER 라서 여전히 동작)
-- ※ RLS 는 그대로 둔다: 관리자 페이지의 update(is_admin) 같은 경우 필요

-- ============================================================================
-- 7. 페이지네이션/검색 인덱스
-- ============================================================================
create index if not exists idx_app_users_nickname_lower on app_users ((lower(nickname)));
create index if not exists idx_app_users_created         on app_users (created_at desc);
create index if not exists idx_sessions_room_played      on sessions  (room_code, played_on desc);
create index if not exists idx_user_sessions_user_sess   on user_sessions (user_id, session_id desc);

-- ============================================================================
-- 8. 관리자 페이지 전용 검색 RPC (닉네임 부분일치, 페이지네이션)
-- ============================================================================
create or replace function admin_list_users(p_search text default null,
                                             p_limit  int default 50,
                                             p_offset int default 0)
returns table(id uuid, nickname text, is_admin boolean,
              created_at timestamptz, last_seen_at timestamptz, total_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  q text;
begin
  q := coalesce('%' || lower(p_search) || '%', '%%');
  return query
    with matched as (
      select u.id, u.nickname, coalesce(u.is_admin,false) as is_admin,
             u.created_at, u.last_seen_at
        from app_users u
        where lower(u.nickname) like q
        order by u.created_at desc
    ),
    counted as (select count(*) from matched)
    select m.*, (select * from counted) as total_count
      from matched m
      limit p_limit offset p_offset;
end;
$$;

grant execute on function admin_list_users(text, int, int) to anon, authenticated;
