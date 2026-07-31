// 공통 테스트 도우미 — jsdom으로 index.html을 실제로 실행한다.
// 서버·빌드 과정이 없는 단일 HTML 앱이라, 앱을 화면처럼 조작하는 것이 유일하게 의미 있는 테스트다.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const HTML_PATH = path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(HTML_PATH, "utf8");

// 앱을 새 브라우저 컨텍스트에서 부팅한다. url에 #v1=... 을 주면 공유 링크로 여는 경로가 된다.
function boot(url = "https://example.com/tennis/") {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, url });
  const w = dom.window, d = w.document;
  const errs = [];
  w.addEventListener("error", e => errs.push("ERR " + ((e.error && e.error.stack) || e.message)));
  w.confirm = () => true;   // 확인 대화상자는 기본 승인 (거절 경로는 개별 테스트에서 덮어쓴다)
  return {
    w, d, errs,
    $: s => d.querySelector(s),
    $$: (s, root) => [...(root || d).querySelectorAll(s)],
  };
}

const click = (w, el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
const fire = (w, el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 종목 선택 화면 통과 — kind: "single" | "same" | "mixed"
function pickMode(ctx, kind) {
  const { w, d, $$ } = ctx;
  const step1 = $$("#intro button").find(b => new RegExp(kind === "single" ? "단식" : "복식").test(b.textContent));
  click(w, step1);
  if (kind !== "single") {
    const step2 = $$("#intro button").find(b => new RegExp(kind === "mixed" ? "혼성" : "동성").test(b.textContent));
    click(w, step2);
  }
}

function fillNames(ctx, prefix = "선수") {
  const { w, $$ } = ctx;
  const ins = $$("#names input");
  ins.forEach((i, k) => { i.value = prefix + k; fire(w, i, "input"); });
  return ins;
}

// 대진표 DOM에서 라운드별 [[teamA idx[], teamB idx[]], ...] 를 읽는다.
// 이름을 p0, p1 … 로 넣었을 때만 유효하다 (등급 배지 A/B/C는 제거한다).
function readSchedule(ctx) {
  const { $$ } = ctx;
  return $$("#sched .round").map(r => $$(".court", r).map(c =>
    $$(".nm", c).map(e => e.textContent.split("·").map(t => +t.trim().replace(/^p/, "").replace(/[ABC]$/, "")))
  ));
}

// 간단한 결과 집계 — 실패가 하나라도 있으면 프로세스 종료 코드를 1로 만든다
function reporter(title) {
  let pass = 0, fail = 0;
  const failures = [];
  console.log("\n=== " + title + " ===");
  return {
    ok(cond, msg) {
      if (cond) { pass++; console.log("  ok   " + msg); }
      else { fail++; failures.push(msg); console.log("  FAIL " + msg); }
    },
    info(msg) { console.log("  ·    " + msg); },
    section(msg) { console.log("\n--- " + msg + " ---"); },
    done() {
      console.log("\n" + title + ": " + pass + " 통과 / " + fail + " 실패");
      if (fail) {
        console.log("실패 목록:");
        failures.forEach(f => console.log("  - " + f));
      }
      return fail;
    },
  };
}

module.exports = { HTML_PATH, boot, click, fire, sleep, pickMode, fillNames, readSchedule, reporter };
