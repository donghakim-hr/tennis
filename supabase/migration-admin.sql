-- 관리자 권한 추가 마이그레이션
-- Supabase SQL Editor에서 한 번 실행한다.

-- 1. app_users에 is_admin 컬럼 추가
alter table app_users add column if not exists is_admin boolean not null default false;

-- 2. 관리자로 지정할 닉네임을 아래 SQL에 넣고 실행
--    예: update app_users set is_admin = true where nickname = '홍길동';
-- update app_users set is_admin = true where nickname = '여기에_닉네임';
