// 대진 생성 알고리즘 전 조합 스윕
//
// 4종목(단식 / 동성 / 혼성-랜덤 / 혼성-고정조) × 등급 사용·미사용 × 인원 4~16명
// × 선택 가능한 모든 코트 수 × 1인당 2·4·6경기 = 약 700개 조합을 실제 화면 조작으로 생성하고,
// 사양서 3-4의 '보장 사항'이 전부 지켜지는지 매번 검사한다.
//
// 실행: node tests/algorithm.test.js   (약 1~2분)
const { boot, click, pickMode, fillNames, readSchedule, reporter } = require("./lib");

const GAMES = [2, 4, 6];
const MODES = [
  { kind: "single", type: "single", perCourt: 2, label: "단식" },
  { kind: "same",   type: "same",   perCourt: 4, label: "동성" },
  { kind: "mixed",  type: "mixed",  perCourt: 4, label: "혼성/랜덤", partner: "random" },
  { kind: "mixed",  type: "mixed",  perCourt: 4, label: "혼성/고정조", partner: "fixed" },
];

// 사양서 2-4 / 2-7 의 라운드 수 공식을 테스트 쪽에서 독립적으로 다시 계산한다
function expectedRounds(M, n, courts, games) {
  if (M.partner === "fixed") return Math.ceil(Math.floor(n / 2) * games / (courts * 2));
  if (M.type === "mixed") {
    const men = Math.ceil(n / 2), women = Math.floor(n / 2);   // 기본 성별은 남·여 번갈아
    return Math.ceil(games * Math.max(men, women) / (courts * 2));
  }
  return Math.ceil(n * games / (courts * M.perCourt));
}

// 출전 편차를 확인할 그룹 — 혼복은 성별 내, 고정 조는 조 내에서 편차 ≤ 1 이어야 한다
function groupsOf(M, n) {
  const all = Array.from({ length: n }, (_, i) => i);
  if (M.partner === "fixed") return Array.from({ length: Math.floor(n / 2) }, (_, i) => [2 * i, 2 * i + 1]);
  if (M.type === "mixed") return [all.filter(i => i % 2 === 0), all.filter(i => i % 2 === 1)];
  return [all];
}

(function main() {
  const R = reporter("대진 생성 알고리즘 전 조합");
  const ctx = boot();
  const { w, d, $, $$ } = ctx;

  const setCount = n => {
    let guard = 40;
    while (+$("#p-val").textContent > n && guard--) click(w, $("#p-minus"));
    while (+$("#p-val").textContent < n && guard--) click(w, $("#p-plus"));
    return +$("#p-val").textContent === n;
  };
  const courtOptions = () => $$("#c-chips button").filter(b => !b.disabled).map(b => +b.dataset.c);

  let combos = 0;
  const problems = [];
  const note = (tag, msg) => problems.push(tag + " :: " + msg);

  for (const M of MODES) {
    for (const useLevel of [false, true]) {
      click(w, $("#mode-change"));
      pickMode(ctx, M.kind);
      if (M.partner) click(w, $$("#pt-seg button").find(b => b.dataset.p === M.partner));
      click(w, $$("#lv-seg button").find(b => b.dataset.l === (useLevel ? "on" : "off")));

      for (let n = 4; n <= 16; n++) {
        if (M.partner === "fixed" && n % 2) continue;          // 고정 조는 짝수 인원만
        if (!setCount(n)) { note("setCount", n + "명 설정 실패"); continue; }
        if (useLevel) {
          // 등급을 A/B/C로 흩뿌린다 (기본 B에서 k%3 번 눌러 B→C→A)
          $$("#names .lvbtn").forEach((_, k) => {
            for (let t = 0; t < k % 3; t++) click(w, $$("#names .lvbtn")[k]);
          });
        }

        for (const courts of courtOptions()) {
          click(w, $$("#c-chips button").find(b => +b.dataset.c === courts));
          for (const games of GAMES) {
            click(w, $$("#r-chips button").find(b => +b.dataset.r === games));
            if ($("#make").disabled) continue;                  // 설정이 불가능한 조합은 건너뛴다
            fillNames(ctx, "p");
            click(w, $("#make"));
            combos++;

            const tag = `${M.label}${useLevel ? "+등급" : ""} ${n}명/${courts}코트/${games}경기`;
            const sched = readSchedule(ctx);

            const expR = expectedRounds(M, n, courts, games);
            if (sched.length !== expR) note(tag, `라운드 ${sched.length} ≠ 예상 ${expR}`);
            if (!sched.every(r => r.length === courts)) note(tag, "코트 수가 설정과 다르다");

            const played = new Array(n).fill(0);
            sched.forEach(r => r.forEach(m => m[0].concat(m[1]).forEach(p => {
              if (!(p >= 0 && p < n)) note(tag, "잘못된 참가자 번호 " + p);
              played[p]++;
            })));
            groupsOf(M, n).forEach(grp => {
              const vs = grp.map(i => played[i]);
              const lo = Math.min(...vs), hi = Math.max(...vs);
              if (lo < games) note(tag, `목표 미달 ${lo} < ${games}`);
              if (hi - lo > 1) note(tag, `출전 편차 ${hi - lo} > 1`);
            });

            sched.forEach((r, ri) => r.forEach((m, ci) => {
              if (m[0].length !== M.perCourt / 2 || m[1].length !== M.perCourt / 2) note(tag, "팀 인원 오류");
              if (M.type === "mixed") {
                [m[0], m[1]].forEach(t => {
                  if (t.filter(x => x % 2 === 0).length !== 1) note(tag, `혼성 팀이 남1·여1이 아니다 R${ri + 1}C${ci + 1} [${t}]`);
                });
              }
              if (M.partner === "fixed") {
                [m[0], m[1]].forEach(t => {
                  const [x, y] = t.slice().sort((a, b) => a - b);
                  if (!(y - x === 1 && x % 2 === 0)) note(tag, `고정 조 편성 위반 [${t}]`);
                });
              }
            }));

            // 1라운드 코트1 고정 (복식 1·2 vs 3·4 / 단식 1 vs 2)
            const first = sched[0][0].flat().sort((a, b) => a - b).join(",");
            const want = M.perCourt === 2 ? "0,1" : "0,1,2,3";
            if (first !== want) note(tag, `1라운드 코트1 고정 위반 (${first})`);
          }
        }
      }
    }
  }

  R.info("생성한 조합: " + combos + "개");
  R.ok(problems.length === 0, "모든 조합이 보장 사항을 지킨다" + (problems.length ? ` (위반 ${problems.length}건)` : ""));
  problems.slice(0, 20).forEach(p => console.log("      " + p));
  R.ok(ctx.errs.length === 0, "런타임 오류 없음" + (ctx.errs.length ? ": " + ctx.errs[0] : ""));

  process.exit(R.done() ? 1 : 0);
})();
