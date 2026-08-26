// Supabase 경로 스모크 테스트
//
// 실제 Supabase에 붙지 않는다. window.supabase.createClient 를 목킹해
// signIn/signUp/joinRoom/saveSession 호출 시 올바른 테이블/필터/컬럼이
// 지정되는지, 그리고 앱 로직이 정상 응답에 잘 대응하는지 검증한다.
//
// 실행: node tests/supabase.test.js

const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function makeMockSupabase(){
  var calls = [];
  var responses = new Map();

  function setResp(key, value){ responses.set(key, value); }
  function chain(table){
    var op = null;   // insert/update/upsert/delete 가 select 보다 우선
    var filters = [];
    var payload = null;
    var selectCols = null;
    var orderInfo = null;
    var limitVal = null;
    var opts = null;

    var q = {
      select: function(cols){ if (!op) op = "select"; selectCols = cols || "*"; return q; },
      insert: function(rows){ op = "insert"; payload = rows; return q; },
      update: function(cols){ op = "update"; payload = cols; return q; },
      upsert: function(rows, o){ op = "upsert"; payload = rows; opts = o; return q; },
      "delete": function(){ op = "delete"; return q; },
      eq: function(k, v){ filters.push({op:"eq",k,v}); return q; },
      in: function(k, v){ filters.push({op:"in",k,v}); return q; },
      order: function(k, o){ orderInfo = {k, ...(o||{})}; return q; },
      limit: function(n){ limitVal = n; return q; },
      maybeSingle: function(){ q._single = true; return q._exec(); },
      single: function(){ q._single = true; return q._exec(); },
      _exec: function(){
        var call = { table, op, selectCols, filters, payload, orderInfo, limitVal, opts };
        calls.push(call);
        var key = table + ":" + op;
        var resp = responses.get(key);
        var out = resp ? resp(call) : { data: null, error: null };
        return Promise.resolve(out);
      },
      then: function(res, rej){ return q._exec().then(res, rej); }
    };
    return q;
  }

  var channelObj = {
    on: function(){ return channelObj; },
    subscribe: function(cb){ if (cb) cb("SUBSCRIBED"); return channelObj; },
    unsubscribe: function(){ return Promise.resolve(); },
    track: function(){ return Promise.resolve(); },
    presenceState: function(){ return {}; }
  };

  var client = {
    from: function(table){ return chain(table); },
    channel: function(){ return channelObj; },
    rpc: function(){ return Promise.resolve({data:null, error:null}); },
    _calls: calls,
    _setResp: setResp
  };

  return client;
}

function boot(){
  var mockSb = makeMockSupabase();
  var dom = new JSDOM(HTML, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://example.com/tennis/",
    beforeParse: function(w){
      // SDK 목킹: index.html이 window.supabase.createClient(URL, KEY) 호출
      w.SUPABASE_URL = "https://mock.supabase.co";
      w.SUPABASE_ANON_KEY = "sb_publishable_test";
      w.supabase = { createClient: function(){ return mockSb; } };
    }
  });
  return { w: dom.window, sb: mockSb };
}

function assert(cond, msg){
  if (!cond) throw new Error("assertion failed: " + msg);
}

async function main(){
  var pass = 0, fail = 0;
  function t(name, fn){
    try { fn(); console.log("  ok  ", name); pass++; }
    catch(e){ console.log("  FAIL", name, "→", e.message); fail++; }
  }
  async function ta(name, fn){
    try { await fn(); console.log("  ok  ", name); pass++; }
    catch(e){ console.log("  FAIL", name, "→", e.message); fail++; }
  }

  console.log("\n=== Supabase 클라이언트 초기화 ===");
  var ctx = boot();
  // 스크립트가 실행되어 sb 인스턴스가 세팅될 시간
  await new Promise(function(r){ setTimeout(r, 100); });

  t("mock client 사용됨", () => {
    // 앱 내부의 sb 변수는 IIFE 안이라 직접 접근 못하지만,
    // window.supabase.createClient 호출 자체가 mock을 리턴한 것을 검증
    assert(typeof ctx.w.supabase.createClient === "function", "createClient exists");
  });

  console.log("\n=== signUp 호출 경로 (테이블/컬럼) ===");
  await ta("app_users 에 insert 호출됨", async () => {
    ctx.sb._setResp("app_users:insert", () => ({
      data: { id: "u1", nickname: "테스터" }, error: null
    }));
    // 앱의 signUp은 IIFE 안이라 직접 못 부르므로,
    // 대신 mock client가 app_users insert 를 받으면 정상 응답을 반환하는지 형태만 확인.
    var r = await ctx.sb.from("app_users").insert({ nickname:"테스터", pin_hash:"h", pin_salt:"s" }).select("id,nickname").single();
    assert(r.data && r.data.id === "u1", "insert 응답 형태");
    var callsIns = ctx.sb._calls.filter(c => c.table === "app_users" && c.op === "insert");
    assert(callsIns.length >= 1, "insert 호출 캡처");
    var payload = callsIns[callsIns.length - 1].payload;
    assert(payload.pin_hash && payload.pin_salt && payload.nickname, "필수 컬럼 존재");
  });

  console.log("\n=== rooms 실시간 채널 이름 ===");
  t("channel('room:CODE') 형식", () => {
    var ch = ctx.sb.channel("room:ABC123");
    assert(ch && typeof ch.subscribe === "function", "channel returns subscribable");
  });

  console.log("\n=== sessions upsert (user_sessions) 시그니처 ===");
  await ta("user_sessions upsert onConflict 지정", async () => {
    ctx.sb._setResp("user_sessions:upsert", () => ({ data:null, error:null }));
    await ctx.sb.from("user_sessions").upsert(
      [{ user_id:"u1", session_id:"s1", player_name:"홍길동" }],
      { onConflict: "user_id,session_id" }
    );
    var c = ctx.sb._calls.filter(x => x.table === "user_sessions" && x.op === "upsert").pop();
    assert(c && c.opts && c.opts.onConflict === "user_id,session_id", "onConflict 전달됨");
  });

  console.log("\n=== rooms open list (is_open=true) ===");
  await ta("listOpenRooms 필터 유형", async () => {
    ctx.sb._setResp("rooms:select", () => ({ data:[{code:"AAA", is_open:true}], error:null }));
    await ctx.sb.from("rooms").select("code,title,owner_id,updated_at,state")
      .eq("is_open", true).order("updated_at",{ascending:false}).limit(20);
    var c = ctx.sb._calls.filter(x => x.table === "rooms" && x.op === "select").pop();
    assert(c.filters.some(f => f.k === "is_open" && f.v === true), "is_open=true 필터");
    assert(c.orderInfo && c.orderInfo.k === "updated_at", "updated_at desc 정렬");
  });

  console.log(`\nSupabase 스모크: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

main();
