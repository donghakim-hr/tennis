-- 관리자 방 삭제 정책 추가
-- Supabase SQL Editor에서 한 번 실행한다.

drop policy if exists "delete rooms" on rooms;
create policy "delete rooms" on rooms for delete using (true);
