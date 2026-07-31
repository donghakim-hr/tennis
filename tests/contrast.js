// 팔레트 대비비 검사기 — index.html의 :root 토큰을 실제로 읽어 WCAG 기준 통과 여부를 본다.
// 색을 바꾸기 전/후에 이걸 먼저 돌린다.  실행: npm run contrast
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

// :root 안의 --토큰: #hex 를 모두 수집
const tokens = {};
const rootBlock = (html.match(/:root\{([\s\S]*?)\}/) || [])[1] || "";
rootBlock.replace(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g, (_, k, v) => { tokens[k] = v; return ""; });

const lum = hex => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const c = h.slice(0, 6).match(/../g).map(x => parseInt(x, 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
// 흰색 알파를 배경 위에 합성한 실효 색
const overWhite = (bg, alpha) => {
  const h = bg.replace("#", "").match(/../g).map(x => parseInt(x, 16));
  return "#" + h.map(v => Math.round(v * (1 - alpha) + 255 * alpha).toString(16).padStart(2, "0")).join("");
};

const T = k => tokens[k] || "#000000";
console.log("읽어온 토큰: " + Object.keys(tokens).map(k => "--" + k + " " + tokens[k]).join(", ") + "\n");

// [설명, 전경, 배경, 최소 요구비] — 본문 텍스트 4.5 / 큰 텍스트·비텍스트 3.0
const CHECKS = [
  ["보조 텍스트 (--muted) on 카드", T("muted"), T("card"), 4.5],
  ["보조 텍스트 (--muted) on 배경", T("muted"), T("bg"), 4.5],
  ["본문 (--ink) on 카드", T("ink"), T("card"), 4.5],
  ["강조 (--court) on 카드", T("court"), T("card"), 4.5],
  ["흰 글씨 on 코트", "#ffffff", T("court"), 4.5],
  ["흰 글씨 on 완료 코트", "#ffffff", T("court-dark"), 4.5],
  ["코트 라벨 (흰 .95)", overWhite(T("court"), 0.95), T("court"), 3.0],
  ["팀 라벨 A/B (흰 .88)", overWhite(T("court"), 0.88), T("court"), 3.0],
  ["점수 placeholder (흰 .8)", overWhite(T("court"), 0.8), T("court"), 3.0],
  ["점수 칸 테두리 (흰 .6, 2px)", overWhite(T("court"), 0.6), T("court"), 3.0],
  ["승리 점수 글씨 on 공색", "#16240a", T("ball"), 4.5],
  ["득실 + (--win) on 카드", T("win"), T("card"), 4.5],
  ["경고문 on 경고 배경", "#8f2f2f", "#fdecec", 4.5],
  ["등급 A 배지", "#256b39", "#eaf5ec", 4.5],
  ["등급 C 배지", "#96601f", "#fdf1e5", 4.5],
  ["성별 남 배지", "#1d5b96", "#e8f0fa", 4.5],
  ["성별 여 배지", "#a83a66", "#fbe9f0", 4.5],
];

let fail = 0;
CHECKS.forEach(([label, fg, bg, need]) => {
  const r = ratio(fg, bg);
  const pass = r >= need;
  if (!pass) fail++;
  console.log((pass ? "  ok   " : "  FAIL ") + r.toFixed(2).padStart(5) + " (필요 " + need.toFixed(1) + ")  " + label);
});

console.log("\n" + (fail ? fail + "개 항목이 기준 미달" : "모든 색 조합이 기준 통과"));
process.exit(fail ? 1 : 0);
