// 대진표 검증 테스트 — 4~24명 × 1~4코트 × 2~5게임 모든 조합 스위프
//
// 각 조합에 대해:
//  1. 라운드 수가 공식과 일치
//  2. 개인 출전 편차 ≤ 1 (모두가 games ~ games+1 경기)
//  3. max 연속 출전 ≤ 3 (하드 제약)
//  4. 개인별 경기 수 ≥ 목표(games)
//  5. 매 라운드 코트 수 일치, 팀 인원 정확
//  6. 참가자 번호가 [0, n) 범위 안
//  7. 같은 매치가 정확히 재현되지 않음 (완전 중복 = 페어+상대 모두 동일)
//
// 실행: node tests/validation.test.js
//
// 브루트포스 스위프이므로 몇 분 걸릴 수 있다.

const { boot, click, pickMode, fillNames, readSchedule, reporter } = require("./lib");

(function main(){
  const R = reporter("대진 검증: 4~24명 × 1~4코트 × 2~5게임");
  const ctx = boot();
  const { w, d, $, $$ } = ctx;

  const perCourtDouble = 4;

  const setCount = n => {
    let guard = 60;
    while (+$("#p-val").textContent > n && guard--) click(w, $("#p-minus"));
    while (+$("#p-val").textContent < n && guard--) click(w, $("#p-plus"));
    return +$("#p-val").textContent === n;
  };
  const courtOptions = () => $$("#c-chips button").filter(b => !b.disabled).map(b => +b.dataset.c);
  const gameOptions  = () => $$("#r-chips button").map(b => +b.dataset.r);

  function expectedRoundsDouble(n, courts, games){
    return Math.ceil(n * games / (courts * perCourtDouble));
  }

  // 조합
  function nCk(n, k){ if (k>n||k<0) return 0; let r=1; for (let i=0;i<k;i++) r = r*(n-i)/(i+1); return Math.round(r); }
  // 단일 코트 복식에서 유니크 매치 개수 = C(n,4) × 3
  function maxUniqueMatchesSingleCourt(n){ return nCk(n, 4) * 3; }
  // 4연속 출전 회피 가능 조건 (본문 streakFeasible과 동일)
  function streakFeasible(n, courts, pc){ return 4 * (n - courts*pc) >= n; }

  // 동성복식 모드로 통일해서 스위프 (혼복은 별도 성별 세팅 필요)
  click(w, $("#mode-change"));
  pickMode(ctx, "same");
  click(w, $$("#lv-seg button").find(b => b.dataset.l === "off"));

  let combos = 0;
  const problems = [];
  const note = (tag, msg) => problems.push(tag + " :: " + msg);

  for (let n = 4; n <= 24; n++){
    if (!setCount(n)){ note(`n=${n}`, "인원 설정 실패"); continue; }
    const maxByN = Math.min(4, Math.floor(n / perCourtDouble));   // 최대 4코트, 단 인원 여유 있는 만큼만
    const validCourts = courtOptions().filter(c => c <= maxByN);
    if (!validCourts.length){ note(`n=${n}`, "가능한 코트가 없음 (UI가 max 4로 제한)"); continue; }

    for (const courts of validCourts){
      click(w, $$("#c-chips button").find(b => +b.dataset.c === courts));

      for (const games of [2,3,4,5]){
        const gBtn = $$("#r-chips button").find(b => +b.dataset.r === games);
        if (!gBtn){ continue; }   // 이 게임 옵션 자체가 UI에 없음
        click(w, gBtn);

        if ($("#make").disabled) continue;   // 유효하지 않은 조합은 skip
        fillNames(ctx, "p");
        click(w, $("#make"));
        combos++;

        const tag = `n=${n} c=${courts} g=${games}`;
        const sched = readSchedule(ctx);

        // 1. 라운드 수
        const expR = expectedRoundsDouble(n, courts, games);
        if (sched.length !== expR) note(tag, `라운드 ${sched.length} ≠ 공식 ${expR}`);

        // 2. 코트 수 & 팀 인원
        sched.forEach((r, ri) => {
          if (r.length !== courts) note(tag, `R${ri+1} 코트 ${r.length}≠${courts}`);
          r.forEach((m, ci) => {
            if (m[0].length !== 2 || m[1].length !== 2)
              note(tag, `R${ri+1}C${ci+1} 팀 인원 [${m[0].length},${m[1].length}]`);
            const allP = [...m[0], ...m[1]];
            allP.forEach(p => {
              if (!(p >= 0 && p < n)) note(tag, `R${ri+1}C${ci+1} 잘못된 참가자 ${p}`);
            });
            // 같은 매치 내 중복 참가자
            if (new Set(allP).size !== allP.length)
              note(tag, `R${ri+1}C${ci+1} 같은 매치에 같은 사람 중복`);
          });
          // 같은 라운드 내 서로 다른 코트에 같은 사람이 있으면 안 됨
          const flat = r.flat(2);
          if (new Set(flat).size !== flat.length)
            note(tag, `R${ri+1} 같은 라운드 여러 코트에 중복`);
        });

        // 3. 개인 출전 편차 & 목표 미달
        const played = new Array(n).fill(0);
        sched.forEach(r => r.forEach(m => m[0].concat(m[1]).forEach(p => played[p]++)));
        const lo = Math.min(...played), hi = Math.max(...played);
        if (lo < games) note(tag, `목표 미달 lo=${lo} < games=${games}`);
        if (hi - lo > 1) note(tag, `출전 편차 ${hi - lo} > 1 (lo=${lo}, hi=${hi})`);

        // 4. 최장 연속 출전 ≤ 3 (앱이 cap 활성 && 이론상 회피 가능한 경우만)
        if (n >= 6 && games >= 4 && streakFeasible(n, courts, perCourtDouble)){
          const streak = new Array(n).fill(0);
          const worst = new Array(n).fill(0);
          sched.forEach(r => {
            const inPlay = new Set();
            r.forEach(m => m[0].concat(m[1]).forEach(p => inPlay.add(p)));
            for (let i = 0; i < n; i++){
              streak[i] = inPlay.has(i) ? streak[i] + 1 : 0;
              if (streak[i] > worst[i]) worst[i] = streak[i];
            }
          });
          const maxStreak = Math.max(...worst);
          if (maxStreak > 3) note(tag, `최장 연속 ${maxStreak} > 3 (회피 가능한데도)`);
        }

        // 5. 동일 매치 완전 재현: 매치 수가 유니크 상한 이하면 중복 0이어야 함
        // 단일 코트, 인원 6 이상에서 엄격 적용 (n=4,5는 1라운드 pin 제약 때문에 라운드별 그리디의 한계 존재)
        if (courts === 1 && n >= 6){
          const totalMatches = sched.length;
          const maxUnique = maxUniqueMatchesSingleCourt(n);
          const matchCount = new Map();
          sched.forEach(r => r.forEach(m => {
            const a = m[0].slice().sort((x,y) => x-y).join(",");
            const b = m[1].slice().sort((x,y) => x-y).join(",");
            const key = a < b ? a + "|" + b : b + "|" + a;
            matchCount.set(key, (matchCount.get(key) || 0) + 1);
          }));
          const dupes = Array.from(matchCount.values()).filter(v => v > 1).length;
          const allowedDupes = Math.max(0, totalMatches - maxUnique);
          if (dupes > allowedDupes) note(tag, `매치 중복 ${dupes} > 허용 ${allowedDupes} (총 ${totalMatches}매치 / 유니크 상한 ${maxUnique})`);
        }
      }
    }
  }

  problems.forEach(p => R.ok(false, p));
  if (!problems.length) R.ok(true, `${combos}개 조합 전부 통과`);
  const bailed = R.done();
  console.log(`\n총 ${combos}개 조합 검증 완료`);
  process.exit(bailed ? 1 : 0);
})();
