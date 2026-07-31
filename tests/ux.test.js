// UI/UX 동작 테스트 — 접이식 설정, 점수 입력, 탭, 코트 수, 명단 불러오기
// 실행: node tests/ux.test.js
const { boot, click, fire, sleep, pickMode, fillNames, reporter } = require("./lib");

const foldState = ctx => ctx.$$("#setup .fold")
  .map(c => c.dataset.fold + (c.classList.contains("closed") ? ":접힘" : ":펼침")).join(" ");
const isClosed = (ctx, key) => ctx.d.querySelector('[data-fold="' + key + '"]').classList.contains("closed");

(async function main() {
  const R = reporter("UI/UX 동작");

  // ---------- A. 설정 화면 첫 인상 ----------
  R.section("설정 화면 첫 인상");
  {
    const ctx = boot();
    const { w, d, $ } = ctx;
    await sleep(150);
    pickMode(ctx, "same");
    R.info(foldState(ctx));
    R.ok(!$("#fold-all").hidden, "이름을 입력하지 않아도 '설정 모두 접기'가 보인다");
    R.ok(isClosed(ctx, "mode") && isClosed(ctx, "date") && isClosed(ctx, "level"),
      "이미 정해진 값(종목·일자·등급)은 접힌 상태로 시작");
    R.ok(!isClosed(ctx, "count") && !isClosed(ctx, "courts") && !isClosed(ctx, "games") && !isClosed(ctx, "names"),
      "직접 정해야 하는 값(인원·코트·경기수·이름)은 펼쳐져 있다");

    click(w, d.querySelector('[data-fold="count"] .foldhead'));
    R.ok(isClosed(ctx, "count"), "이름 미입력 상태에서도 카드를 접을 수 있다");

    R.ok(!$("#setupbar").hidden, "설정 화면 하단 고정 CTA 표시");
    R.info("CTA: " + $("#setupmsg").textContent);
    R.ok(/명/.test($("#setupmsg").textContent) && /라운드/.test($("#setupmsg").textContent),
      "CTA에 인원·코트·라운드 요약");

    R.ok(/월/.test(d.querySelector('[data-fold="date"] .foldsum').textContent), "접힌 일자 요약이 '7월 31일 (금)' 형식");
    click(w, d.querySelector('[data-fold="games"] .foldhead'));
    R.ok(/총 \d+라운드/.test(d.querySelector('[data-fold="games"] .foldsum').textContent),
      "접힌 경기수 요약에 총 라운드 포함");

    fillNames(ctx);
    click(w, $("#make2"));
    R.ok(!$("#sched").hidden, "하단 CTA로 대진 생성");
    R.ok($("#setupbar").hidden, "대진 생성 후 설정 CTA 숨김");
    R.ok(ctx.errs.length === 0, "런타임 오류 없음" + (ctx.errs.length ? ": " + ctx.errs[0] : ""));
  }

  // ---------- B. 자동 접기 타이밍 ----------
  R.section("자동 접기 타이밍");
  {
    const ctx = boot();
    const { w, d, $$ } = ctx;
    await sleep(150);
    pickMode(ctx, "same");
    const ins = fillNames(ctx);

    ins[0].focus(); ins[1].focus();
    fire(w, ins[0], "blur");
    await sleep(30);
    R.ok(!isClosed(ctx, "names"), "이름 칸 사이 이동 중에는 접히지 않는다 (마지막 탭이 빗나가던 문제)");

    ins[1].blur(); fire(w, ins[1], "blur");
    await sleep(30);
    R.ok(isClosed(ctx, "names"), "포커스가 설정 화면을 벗어나면 자동으로 접힌다");

    click(w, d.querySelector('[data-fold="names"] .foldhead'));
    const first = $$("#names input")[0];
    first.value = ""; fire(w, first, "input");
    first.value = "선수0"; fire(w, first, "input");
    await sleep(30);
    R.ok(!isClosed(ctx, "names"), "손으로 펼친 카드는 이름을 고쳐도 다시 접히지 않는다");
  }

  // ---------- C. 점수 입력 ----------
  R.section("점수 입력");
  {
    const ctx = boot();
    const { w, d, $, $$ } = ctx;
    await sleep(150);
    pickMode(ctx, "same");
    fillNames(ctx);
    click(w, $("#make"));

    const side = $$("#sched .side")[0];
    click(w, $$(".players", side)[0]);
    R.ok(d.activeElement === $$(".score", side)[0], "코트 카드 어디를 눌러도 그 팀 점수 칸으로 포커스");

    const badge = () => $$("#sched .round-tag")[0];
    R.ok(/^0 \/ \d+$/.test(badge().textContent.trim()), "라운드 헤더에 진행도 배지: " + badge().textContent);
    const sc = $$("#sched .score");
    sc[0].value = "6"; fire(w, sc[0], "input");
    sc[1].value = "4"; fire(w, sc[1], "input");
    R.ok(badge().textContent.trim().indexOf("1 /") === 0, "점수 입력 시 배지 즉시 갱신: " + badge().textContent);

    sc.forEach(s => { if (+s.dataset.r === 0 && s.value === "") { s.value = "3"; fire(w, s, "input"); } });
    R.ok(badge().classList.contains("full"), "라운드가 다 차면 배지가 완료 상태");

    R.ok(/자동 저장/.test($("#savemsg").textContent), "저장 바가 자동 저장을 알린다: " + $("#savemsg").textContent);
    await sleep(900);
    R.ok($("#save-btn").textContent === "저장됨", "버튼을 누르지 않아도 700ms 후 저장됨");
    R.ok(!!w.localStorage.getItem("tennis:sessions"), "localStorage에 실제로 기록됨");
    R.ok(ctx.errs.length === 0, "런타임 오류 없음" + (ctx.errs.length ? ": " + ctx.errs[0] : ""));
  }

  // ---------- D. 탭 · ARIA ----------
  R.section("탭 · ARIA");
  {
    const ctx = boot();
    const { w, $, $$ } = ctx;
    await sleep(150);
    pickMode(ctx, "same");
    fillNames(ctx);
    click(w, $("#make"));
    R.ok($("#tabs").getAttribute("role") === "tablist" && $("#tab-sched").getAttribute("role") === "tab",
      "탭에 role=tablist / role=tab");
    R.ok($("#sched").getAttribute("role") === "tabpanel", "패널에 role=tabpanel");
    R.ok($("#prog").getAttribute("aria-live") === "polite", "진행 카운터에 aria-live");
    click(w, $("#tab-summary"));
    R.ok(!$("#summary").hidden && $$("#summary table").length === 2, "요약 탭 표 2개");
    click(w, $("#tab-rank"));
    R.ok(!$("#rank").hidden && $$("#rank tbody tr").length === 8, "순위 탭 8행");
    click(w, $("#tab-sched"));
    R.ok(!$("#sched").hidden, "대진표 탭 복귀");
    R.ok(ctx.errs.length === 0, "런타임 오류 없음" + (ctx.errs.length ? ": " + ctx.errs[0] : ""));
  }

  // ---------- E. 코트 수 ----------
  R.section("코트 수 자동 선택 · 인원 감소");
  {
    const ctx = boot();
    const { w, $, $$ } = ctx;
    await sleep(150);
    click(w, $("#mode-change"));
    pickMode(ctx, "single");
    R.ok(/자동 선택/.test($("#court-detail").textContent), "고르기 전에는 '자동 선택'임을 표기");
    click(w, $$("#c-chips button").find(b => +b.dataset.c === 4));   // 단식 8명 → 4코트
    click(w, $("#p-minus"));                                        // 7명
    const cur = +$$("#c-chips button").find(b => b.getAttribute("aria-pressed") === "true").dataset.c;
    R.ok(cur === 3, "인원을 줄여도 코트가 1면으로 무단 강하하지 않는다 (mode 인자 누락 버그)");
    R.ok(!/자동 선택/.test($("#court-detail").textContent), "직접 고른 뒤에는 '자동 선택' 표기 없음");
  }

  // ---------- F. 지난 명단 불러오기 ----------
  R.section("지난 명단 불러오기");
  {
    const ctx = boot();
    const { w, d, $, $$ } = ctx;
    await sleep(150);
    pickMode(ctx, "same");
    fillNames(ctx, "홍");
    click(w, $("#make"));

    click(w, $("#newday"));
    $("#date").value = "2026-08-07";
    fire(w, $("#date"), "change");
    R.ok(!$("#load-roster").hidden, "지난 회차가 있으면 버튼 노출: " + $("#load-roster").textContent);

    $$("#names input").forEach(i => { i.value = ""; fire(w, i, "input"); });
    click(w, $("#load-roster"));
    const names = $$("#names input").map(i => i.value);
    R.ok(names[0] === "홍0" && names[7] === "홍7", "지난 명단이 이름 칸까지 복원: " + names.join(","));
    R.ok(/월/.test(d.querySelector('[data-fold="date"] .foldsum').textContent), "날짜 변경이 접힌 요약에 반영");
  }

  // ---------- G. 열람 중 보호 ----------
  R.section("열람 중 실수 방지");
  {
    const A = boot();
    await sleep(150);
    pickMode(A, "same");
    fillNames(A, "원본");
    click(A.w, A.$("#make"));
    let copied = null;
    Object.defineProperty(A.w.navigator, "share", { value: undefined, configurable: true });
    Object.defineProperty(A.w.navigator, "clipboard", {
      value: { writeText: t => { copied = t; return Promise.resolve(); } }, configurable: true,
    });
    click(A.w, A.$("#share"));
    await sleep(50);
    const url = String(copied).split("\n").pop();

    const B = boot(url);
    await sleep(250);
    B.w.confirm = () => false;                 // 사용자가 '아니오'를 누른 경우
    click(B.w, B.$("#tab-sched"));
    const before = B.$("#sched").textContent;
    click(B.w, B.$("#make"));                  // 열람 중 대진 생성 시도
    R.ok(B.$("#sched").textContent === before, "열람 중 '대진표 만들기'는 확인을 거절하면 아무 일도 하지 않는다");
    R.ok(B.$$("#sched .score").every(s => s.hasAttribute("readonly")), "여전히 읽기 전용");
  }

  process.exit(R.done() ? 1 : 0);
})();
