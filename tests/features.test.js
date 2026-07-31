// 기능 테스트 — 파트너 고정 / 실력 등급 / 공유 링크 왕복
// 실행: node tests/features.test.js
const { boot, click, fire, sleep, pickMode, fillNames, reporter } = require("./lib");

(async function main() {
  const R = reporter("기능: 고정 조 · 등급 · 공유 링크");

  // ---------- 1) 혼성 복식 + 파트너 고정 + 실력 등급 ----------
  R.section("혼성 복식 · 파트너 고정 · 등급");
  {
    const ctx = boot();
    const { w, d, $, $$ } = ctx;
    await sleep(150);
    pickMode(ctx, "mixed");

    R.ok(!$("#card-partner").hidden, "혼복에서만 파트너 카드가 보인다");
    click(w, $$("#pt-seg button").find(b => b.dataset.p === "fixed"));
    R.ok($("#pt-seg").querySelector('[aria-pressed="true"]').dataset.p === "fixed", "고정 조 선택됨");
    R.info("고정 조 편성: " + $$(".pairchip").map(c => c.textContent).join(" / "));
    R.ok($$(".pairchip").length === 4, "8명 → 4조 편성 표시");

    click(w, $$("#lv-seg button").find(b => b.dataset.l === "on"));
    R.ok($$("#names .lvbtn").length === 8, "등급 버튼이 참가자마다 생성");
    click(w, $$("#names .lvbtn")[0]);
    R.ok($$("#names .lvbtn")[0].textContent === "C", "등급 순환 B → C");
    click(w, $$("#names .lvbtn")[0]);
    R.ok($$("#names .lvbtn")[0].textContent === "A", "등급 순환 C → A");

    fillNames(ctx);
    click(w, $("#make"));
    R.ok(!$("#sched").hidden, "대진 생성");
    R.info("요약: " + $("#sched p").textContent);
    R.ok(/파트너 고정/.test($("#sched p").textContent), "요약에 '파트너 고정' 표기");
    R.ok(/편차/.test($("#sched p").textContent), "요약에 팀 전력 편차 표기");

    click(w, $("#tab-summary"));
    const bad = $$("#summary .vs .t").map(e => e.textContent).find(t => {
      const [a, b] = t.split("·").map(x => +x.replace("선수", ""));
      return !(Math.min(a, b) % 2 === 0 && Math.abs(a - b) === 1);
    });
    R.ok(!bad, "모든 팀이 고정 조 편성 그대로" + (bad ? " ← " + bad : ""));
    R.ok(ctx.errs.length === 0, "런타임 오류 없음" + (ctx.errs.length ? ": " + ctx.errs[0] : ""));
  }

  // ---------- 2) 전원 B일 때는 등급이 적용되지 않음을 알린다 ----------
  R.section("등급 미지정 안내");
  {
    const ctx = boot();
    const { w, $, $$ } = ctx;
    await sleep(150);
    pickMode(ctx, "same");
    click(w, $$("#lv-seg button").find(b => b.dataset.l === "on"));
    R.ok(/전원 B/.test($("#lv-hint").textContent), "전원 B면 '적용되지 않습니다' 경고");
    fillNames(ctx);
    click(w, $("#make"));
    R.ok(!/편차/.test($("#sched p").textContent), "전원 B면 '편차 0.0'을 표시하지 않는다");
  }

  // ---------- 3) 공유 링크 왕복 ----------
  R.section("공유 링크 인코딩 → 디코딩");
  {
    const A = boot();
    await sleep(150);
    pickMode(A, "same");
    for (let i = 0; i < 4; i++) click(A.w, A.$("#p-plus"));    // 12명
    fillNames(A, "홍길동");
    click(A.w, A.$("#make"));
    A.$$("#sched .score").forEach((s, k) => { s.value = String(k % 7); fire(A.w, s, "input"); });

    let copied = null;
    Object.defineProperty(A.w.navigator, "share", { value: undefined, configurable: true });
    Object.defineProperty(A.w.navigator, "clipboard", {
      value: { writeText: t => { copied = t; return Promise.resolve(); } }, configurable: true,
    });
    click(A.w, A.$("#share"));
    await sleep(50);
    R.ok(!!copied && /#v1=/.test(copied), "공유 텍스트·링크 생성");
    R.info("공유 텍스트 첫 줄: " + String(copied).split("\n")[0]);
    const url = String(copied).split("\n").pop();
    R.info("URL 길이: " + url.length + "자");
    R.ok(url.length < 8000, "URL이 상한(8000자) 안");

    const strip = t => t.replace(/공유받은 결과를 보고 있습니다[\s\S]*?수정하기/g, "");
    const originalSched = strip(A.$("#sched").textContent);
    const originalHead = A.$("#sched p").textContent;

    const B = boot(url);
    await sleep(250);
    R.ok(!B.$("#sched").hidden, "공유 링크로 열면 대진 화면이 바로 뜬다");
    R.ok(B.$("#savebar").hidden, "열람용: 저장 바 숨김");
    R.ok(B.$("#reshuffle").hidden && B.$("#newday").hidden, "열람용: 파괴적 버튼 숨김");
    R.ok(/열람용/.test(B.$("#datechip").textContent), "열람용: 헤더 칩 표시");
    R.ok(B.$$("#sched .score").every(s => s.hasAttribute("readonly")), "열람용: 점수 칸 readonly");
    const impBtn = B.$$("#sched .warnbox button")[0];
    R.ok(!!impBtn, "열람용: 대진표 안에 '내 기록에 저장' 버튼");
    R.ok(strip(B.$("#sched").textContent) === originalSched, "대진·점수·휴식이 원본과 완전히 일치");
    R.ok(B.$("#sched p").textContent === originalHead, "요약 줄까지 일치");

    click(B.w, impBtn);
    await sleep(60);
    R.ok(!B.$("#savebar").hidden, "'내 기록에 저장' 후 편집 모드로 전환");
    R.ok(B.$$("#sched .warnbox button").length === 0, "저장 후 안내 카드 사라짐");
    R.ok(B.errs.length === 0, "런타임 오류 없음" + (B.errs.length ? ": " + B.errs[0] : ""));
  }

  // ---------- 4) 깨진 공유 링크 ----------
  R.section("깨진 공유 링크");
  {
    const A = boot();
    await sleep(150);
    pickMode(A, "same");
    fillNames(A, "내기록");
    click(A.w, A.$("#make"));
    const saved = A.w.localStorage.getItem("tennis:sessions");
    R.ok(!!saved, "로컬 기록 저장됨");

    const C = boot("https://example.com/tennis/#v1=aGVsbG8");   // 유효 base64 · 형식 오류
    C.w.localStorage.setItem("tennis:sessions", saved);
    await sleep(250);
    R.ok(!C.$("#intro").hidden, "깨진 링크 → 종목 선택 화면 (내 옛 기록을 남의 결과로 오인하지 않는다)");
    R.ok(C.$$("#intro .warnbox").length === 1, "깨진 링크 안내 표시");
    R.ok(C.$("#sched").hidden, "대진 화면이 열리지 않는다");
  }

  process.exit(R.done() ? 1 : 0);
})();
