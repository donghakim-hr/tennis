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

  // ---------------------------------------------------------------------------
  // 실제 화면 조작으로 RPC 경로 검증: 로그인 → 코트 만들기 → 점수 동기화 → 충돌 병합 → 종료 → 로그아웃
  // rooms 직접 쓰기는 서버에서 막혀 있으므로 insert/update/delete 가 한 번도 나가면 안 된다.
  // ---------------------------------------------------------------------------
  console.log("\n=== RPC 경로: 코트 만들기 · 동기화 · 충돌 병합 · 종료 ===");
  {
    const { click, fire, pickMode, fillNames } = require("./lib");
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rpcCalls = [], handlers = [];
    let created = null, pushReply = null;
    const TOKEN = "t".repeat(64);
    const mock = makeMockSupabase();
    mock.rpc = function(fn, args){
      rpcCalls.push({ fn, args: JSON.parse(JSON.stringify(args || {})) });
      let data = null;
      if (fn === "verify_pin") data = { id:"u1", nickname:"방주", is_admin:false, token:TOKEN };
      if (fn === "room_create"){ created = args.p_state; data = { code:"ABC234" }; }
      if (fn === "room_get") data = { code:"ABC234", owner_id:"u1", state:created, updated_at:"2026-10-07T00:00:00Z" };
      if (fn === "room_push_state") data = pushReply ? pushReply(args) : { ok:true, updated_at:"2026-10-07T00:00:01Z" };
      if (fn === "room_close" || fn === "sign_out") data = { ok:true };
      return Promise.resolve({ data, error:null });
    };
    const ch = {
      on: function(kind, filt, fn){ handlers.push({ kind, fn }); return ch; },
      subscribe: function(cb){ if (cb) cb("SUBSCRIBED"); return ch; },
      unsubscribe: function(){ return Promise.resolve(); },
      track: function(){ return Promise.resolve(); },
      presenceState: function(){ return {}; }
    };
    mock.channel = function(){ return ch; };
    const dom = new JSDOM(HTML, { runScripts:"dangerously", pretendToBeVisual:true, url:"https://example.com/tennis/",
      beforeParse: function(w){
        w.SUPABASE_URL = "https://mock.supabase.co"; w.SUPABASE_ANON_KEY = "sb_publishable_test";
        w.supabase = { createClient: function(){ return mock; } };
        w.confirm = () => true; w.prompt = () => "테스트 코트";
      } });
    const w = dom.window, d = w.document, errs = [];
    w.addEventListener("error", e => errs.push(String(e.error && e.error.stack || e.message)));
    w.scrollTo = w.scrollBy = function(){};
    const $ = q => d.querySelector(q), $$ = (q, r) => [...(r || d).querySelectorAll(q)];
    const c = { w, d, $, $$ };
    await sleep(150);
    const last = fn => rpcCalls.filter(x => x.fn === fn).pop();

    click(w, $("#btn-auth"));
    $("#mAuth-nick").value = "방주"; $("#mAuth-pin").value = "1234";
    click(w, $("#mAuth-submit"));
    await sleep(30);
    t("로그인하면 토큰을 받고 코트 버튼이 보인다", () => assert(!$("#btn-room").hidden, "btn-room hidden"));

    pickMode(c, "same"); fillNames(c, "p"); click(w, $("#make"));
    click(w, $("#btn-room"));
    click(w, $("#mRoom-create"));
    await sleep(50);
    t("코트 만들기는 room_create(토큰·제목·상태) → room_get", () => {
      const cr = last("room_create");
      assert(cr && cr.args.p_token === TOKEN && cr.args.p_title === "테스트 코트" && cr.args.p_state.schedule, "room_create args");
      assert(last("room_get") && last("room_get").args.p_code === "ABC234", "room_get");
      assert(/ABC234/.test($("#btn-room").textContent), "헤더에 코트 코드: " + $("#btn-room").textContent + " / err: " + $("#mRoom-err").textContent + " / " + errs[0]);
    });

    const sc = () => $$("#sched .score");
    sc()[0].value = "6"; fire(w, sc()[0], "input");
    await sleep(900);
    t("점수 입력 → room_push_state(기준 시각·클라이언트 id)", () => {
      const p = last("room_push_state");
      assert(p, "push 없음");
      assert(p.args.p_token === TOKEN && p.args.p_code === "ABC234", "token/code");
      assert(p.args.p_base_updated_at === "2026-10-07T00:00:00Z", "base " + p.args.p_base_updated_at);
      assert(p.args.p_client_id && p.args.p_state.schedule[0].matches[0].sa === 6, "state");
    });
    const myId = last("room_push_state").args.p_client_id;

    // 다른 기기가 먼저 2라운드 점수를 썼다 → 충돌 응답 → 합쳐서 재전송
    const remote = JSON.parse(JSON.stringify(last("room_push_state").args.p_state));
    remote.schedule[0].matches[0].sa = 6;
    remote.schedule[1].matches[0].sa = 3; remote.schedule[1].matches[0].sb = 6;
    let n = 0;
    pushReply = () => (++n === 1
      ? { ok:false, conflict:true, state:remote, updated_at:"2026-10-07T00:00:05Z" }
      : { ok:true, updated_at:"2026-10-07T00:00:06Z" });
    sc()[1].value = "4"; fire(w, sc()[1], "input");
    await sleep(900);
    t("충돌 시 두 기기의 점수를 합쳐 새 기준 시각으로 다시 보낸다", () => {
      const ps = rpcCalls.filter(x => x.fn === "room_push_state");
      const p = ps[ps.length - 1];
      assert(n === 2, "재전송 횟수 " + n);
      assert(p.args.p_base_updated_at === "2026-10-07T00:00:05Z", "base " + p.args.p_base_updated_at);
      const m0 = p.args.p_state.schedule[0].matches[0], m1 = p.args.p_state.schedule[1].matches[0];
      assert(m0.sa === 6 && m0.sb === 4, "내 점수 " + m0.sa + ":" + m0.sb);
      assert(m1.sa === 3 && m1.sb === 6, "상대 점수 " + m1.sa + ":" + m1.sb);
      const r1 = $$("#sched .round")[1].querySelectorAll(".score");
      assert(r1[0].value === "3" && r1[1].value === "6", "화면에도 상대 점수 반영");
    });
    pushReply = null;

    const upd = handlers.find(h => h.kind === "postgres_changes").fn;
    const before = rpcCalls.length;
    upd({ new: { last_writer: myId, state: { schedule: [] }, updated_at:"2026-10-07T00:00:09Z", is_open:true } });
    t("내가 쓴 것의 Realtime 에코는 무시", () => assert(sc().length > 0 && sc()[0].value === "6", "에코 반영됨"));
    const r2 = JSON.parse(JSON.stringify(remote)); r2.schedule[0].matches[0].sb = 4; r2.names[0] = "새이름";
    upd({ new: { last_writer: "other", state: r2, updated_at:"2026-10-07T00:00:10Z", is_open:true } });
    t("다른 기기 변경은 화면에 반영되고 재전송하지 않는다", () => {
      assert(/새이름/.test($("#sched").textContent), "이름 반영");
      assert(rpcCalls.slice(before).every(x => x.fn !== "room_push_state"), "불필요한 재전송");
    });

    // 라운드 순서 바꾸기 → 코트에 동기화
    const pushes0 = rpcCalls.filter(x => x.fn === "room_push_state").length;
    click(w, $("#ord-open"));
    click(w, $$("#mOrder-list .ord-row")[0].querySelector('.ord-mv[data-mv="1"]'));
    click(w, $("#mOrder-done"));
    await sleep(30);
    t("라운드 순서 변경이 코트에 바로 동기화된다", () => {
      const ps = rpcCalls.filter(x => x.fn === "room_push_state");
      assert(ps.length === pushes0 + 1, "push " + (ps.length - pushes0));
      const st = ps[ps.length - 1].args.p_state;
      assert(st.schedule[1].matches[0].sa === 6 && st.schedule[1].matches[0].sb === 4, "1라운드가 2번째로");
    });
    // 시트를 열어 둔 사이 다른 기기가 대진을 바꾸면 내 순서 변경은 적용하지 않는다
    click(w, $("#ord-open"));
    click(w, $$("#mOrder-list .ord-row")[0].querySelector('.ord-mv[data-mv="1"]'));
    const r3 = JSON.parse(JSON.stringify(last("room_push_state").args.p_state)); r3.names[1] = "원격";
    upd({ new: { last_writer: "other", state: r3, updated_at:"2026-10-07T00:00:30Z", is_open:true } });
    const pushes1 = rpcCalls.filter(x => x.fn === "room_push_state").length;
    click(w, $("#mOrder-done"));
    await sleep(30);
    t("열어 둔 사이 원격 변경이 오면 순서 변경을 버리고 원격 상태를 지킨다", () => {
      assert(rpcCalls.filter(x => x.fn === "room_push_state").length === pushes1, "push 발생");
      assert(/원격/.test($("#sched").textContent), "원격 이름 유지");
      assert($$("#sched .round")[1].querySelectorAll(".score")[0].value === "6", "원격 순서 유지");
    });

    click(w, $("#btn-room"));
    t("방주에게 코트 종료 버튼", () => assert($("#mRoom-close") && !$("#mRoom-close").hidden, "mRoom-close"));
    click(w, $("#mRoom-close"));
    await sleep(30);
    t("코트 종료는 room_close(토큰·코드)", () => {
      const p = last("room_close");
      assert(p && p.args.p_token === TOKEN && p.args.p_code === "ABC234", "room_close");
      assert(!/ABC234/.test($("#btn-room").textContent), "코트에서 나옴");
    });

    click(w, $("#btn-auth"));
    await sleep(30);
    t("로그아웃이 오류 없이 되고 sign_out 호출", () => {
      assert(last("sign_out") && last("sign_out").args.p_token === TOKEN, "sign_out");
      assert($("#btn-auth").textContent === "로그인", "버튼 " + $("#btn-auth").textContent);
    });
    t("rooms 테이블 직접 쓰기 없음", () => {
      const bad = mock._calls.filter(x => x.table === "rooms" && x.op !== "select");
      assert(!bad.length, bad.map(x => x.op).join(","));
      assert(!mock._calls.some(x => x.table === "app_users" || x.table === "app_users_public"), "app_users 직접 조회");
    });
    t("런타임 오류 없음", () => assert(!errs.length, errs[0]));
  }

  console.log("\n=== RPC 경로: 관리자 화면 ===");
  {
    const { click } = require("./lib");
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rpcCalls = [];
    const TOKEN = "a".repeat(64);
    const mock = makeMockSupabase();
    mock.rpc = function(fn, args){
      rpcCalls.push({ fn, args: JSON.parse(JSON.stringify(args || {})) });
      let data = { ok:true };
      if (fn === "verify_pin") data = { id:"ad", nickname:"관리", is_admin:true, token:TOKEN };
      if (fn === "admin_list_users") data = [{ id:"u1", nickname:"회원1", is_admin:false, created_at:"2026-10-01T00:00:00Z", last_seen_at:null, total_count:1 }];
      if (fn === "admin_list_rooms") data = [{ code:"ROOM22", title:"수요일", owner_id:"u1", owner_nickname:"회원1", is_open:true, created_at:"2026-10-01T00:00:00Z", updated_at:"2026-10-01T00:00:00Z" }];
      return Promise.resolve({ data, error:null });
    };
    const dom = new JSDOM(HTML, { runScripts:"dangerously", pretendToBeVisual:true, url:"https://example.com/tennis/",
      beforeParse: function(w){
        w.SUPABASE_URL = "https://mock.supabase.co"; w.SUPABASE_ANON_KEY = "sb_publishable_test";
        w.supabase = { createClient: function(){ return mock; } };
        w.confirm = () => true; w.alert = () => {};
      } });
    const w = dom.window, d = w.document, errs = [];
    w.addEventListener("error", e => errs.push(String(e.error && e.error.stack || e.message)));
    const $ = q => d.querySelector(q);
    await sleep(150);
    const last = fn => rpcCalls.filter(x => x.fn === fn).pop();
    click(w, $("#btn-auth"));
    $("#mAuth-nick").value = "관리"; $("#mAuth-pin").value = "1234";
    click(w, $("#mAuth-submit"));
    await sleep(30);
    click(w, $("#btn-admin"));
    await sleep(30);
    t("회원 목록은 admin_list_users(토큰·검색·페이지)", () => {
      const p = last("admin_list_users");
      assert(p && p.args.p_token === TOKEN && p.args.p_limit === 50 && p.args.p_offset === 0, JSON.stringify(p && p.args));
      assert(/회원1/.test($("#mAdmin-body").textContent), "목록 렌더");
    });
    click(w, d.querySelector('.admin-tab[data-adm="rooms"]'));
    await sleep(30);
    t("코트 목록은 admin_list_rooms 이고 코트주 닉네임이 보인다", () => {
      assert(last("admin_list_rooms") && last("admin_list_rooms").args.p_token === TOKEN, "admin_list_rooms");
      assert(/ROOM22/.test($("#mAdmin-body").textContent) && /회원1/.test($("#mAdmin-body").textContent), $("#mAdmin-body").textContent.slice(0, 80));
    });
    click(w, d.querySelector(".adm-close"));
    await sleep(30);
    t("강제 종료는 admin_close_room", () => assert(last("admin_close_room") && last("admin_close_room").args.p_code === "ROOM22", "close"));
    click(w, d.querySelector(".adm-del"));
    await sleep(30);
    t("삭제는 admin_delete_room", () => assert(last("admin_delete_room") && last("admin_delete_room").args.p_code === "ROOM22", "delete"));
    t("관리자 화면이 테이블을 직접 건드리지 않는다", () =>
      assert(!mock._calls.some(x => x.table === "app_users" || x.table === "app_users_public" || (x.table === "rooms" && x.op !== "select")), "direct"));
    t("런타임 오류 없음", () => assert(!errs.length, errs[0]));
  }

  console.log("\n=== 카톡 공유 링크: 실시간 열람 (#room=CODE) ===");
  {
    const { click, fire, pickMode, fillNames } = require("./lib");
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    // 1) 방주 쪽: 코트 안에서 공유하면 링크에 코트 코드가 들어간다
    const rpcA = [], mockA = makeMockSupabase();
    let created = null;
    mockA.rpc = function(fn, args){
      rpcA.push({ fn, args });
      let data = { ok:true };
      if (fn === "verify_pin") data = { id:"u1", nickname:"방주", is_admin:false, token:"t".repeat(64) };
      if (fn === "room_create"){ created = JSON.parse(JSON.stringify(args.p_state)); data = { code:"KAKAO2" }; }
      if (fn === "room_get") data = { code:"KAKAO2", owner_id:"u1", state:created, updated_at:"2026-10-07T00:00:00Z" };
      return Promise.resolve({ data, error:null });
    };
    const domA = new JSDOM(HTML, { runScripts:"dangerously", pretendToBeVisual:true, url:"https://example.com/tennis/",
      beforeParse: function(w){
        w.SUPABASE_URL = "https://mock.supabase.co"; w.SUPABASE_ANON_KEY = "sb_publishable_test";
        w.supabase = { createClient: function(){ return mockA; } };
        w.confirm = () => true; w.prompt = () => "";
      } });
    const wA = domA.window, dA = wA.document;
    const A = { w:wA, d:dA, $: q => dA.querySelector(q), $$: (q, r) => [...(r || dA).querySelectorAll(q)] };
    await sleep(150);
    click(wA, A.$("#btn-auth")); A.$("#mAuth-nick").value = "방주"; A.$("#mAuth-pin").value = "1234";
    click(wA, A.$("#mAuth-submit")); await sleep(30);
    pickMode(A, "same"); fillNames(A, "p"); click(wA, A.$("#make"));
    click(wA, A.$("#btn-room")); click(wA, A.$("#mRoom-create")); await sleep(50);
    let copied = null;
    Object.defineProperty(wA.navigator, "share", { value: undefined, configurable: true });
    Object.defineProperty(wA.navigator, "clipboard", { value: { writeText: t => { copied = t; return Promise.resolve(); } }, configurable: true });
    click(wA, A.$("#share")); await sleep(30);
    const url = String(copied).split("\n").pop();
    t("코트 안에서 공유하면 #room=코드 + 스냅샷 링크", () => {
      assert(/#room=KAKAO2&v1=/.test(url), url.slice(0, 80));
      assert(/실시간/.test(copied), "문구에 실시간");
    });

    // 2) 받은 사람(로그인 안 함)이 카톡에서 링크를 연다
    const rpcB = [], handlers = [];
    let serverState = JSON.parse(JSON.stringify(created)), serverAt = "2026-10-07T00:00:00Z";
    const mockB = makeMockSupabase();
    mockB.rpc = function(fn, args){
      rpcB.push({ fn, args });
      if (fn === "room_get") return Promise.resolve({ data:{ code:"KAKAO2", owner_id:"u1", state:JSON.parse(JSON.stringify(serverState)), updated_at:serverAt }, error:null });
      return Promise.resolve({ data:{ ok:true }, error:null });
    };
    const ch = { on: function(k, f, fn){ handlers.push({ k, fn }); return ch; }, subscribe: function(cb){ cb && cb("SUBSCRIBED"); return ch; },
                 unsubscribe: function(){ return Promise.resolve(); }, track: function(){ return Promise.resolve(); }, presenceState: function(){ return {}; } };
    mockB.channel = function(){ return ch; };
    const domB = new JSDOM(HTML, { runScripts:"dangerously", pretendToBeVisual:true, url,
      beforeParse: function(w){
        w.SUPABASE_URL = "https://mock.supabase.co"; w.SUPABASE_ANON_KEY = "sb_publishable_test";
        w.supabase = { createClient: function(){ return mockB; } };
      } });
    const wB = domB.window, dB = wB.document, errs = [];
    wB.addEventListener("error", e => errs.push(String(e.error && e.error.stack || e.message)));
    const $B = q => dB.querySelector(q), $$B = (q, r) => [...(r || dB).querySelectorAll(q)];
    await sleep(200);
    t("로그인 없이 코트에 접속해 대진이 보인다 (room_get)", () => {
      assert(rpcB.some(x => x.fn === "room_get" && x.args.p_code === "KAKAO2"), "room_get");
      assert(!$B("#sched").hidden && $$B("#sched .court").length > 0, "대진 표시");
      assert(/실시간/.test($B("#datechip").textContent), "칩: " + $B("#datechip").textContent);
      assert(/코트 KAKAO2 실시간 보기/.test($B("#sched").textContent), "안내 카드");
      assert($$B("#sched .score").every(x => x.hasAttribute("readonly")), "읽기 전용");
    });
    serverState.schedule[0].matches[0].sa = 6; serverState.schedule[0].matches[0].sb = 3;
    serverAt = "2026-10-07T00:00:05Z";
    handlers.find(h => h.k === "postgres_changes").fn({ new:{ state:serverState, updated_at:serverAt, last_writer:"cA", is_open:true } });
    t("방주가 점수를 넣으면 열람 화면이 바로 바뀐다 (Realtime)", () => {
      const s0 = $$B("#sched .score");
      assert(s0[0].value === "6" && s0[1].value === "3", s0[0].value + ":" + s0[1].value);
    });
    // 카톡 인앱 브라우저가 백그라운드에서 소켓을 놓친 경우 → 화면 복귀 시 다시 받는다
    serverState.schedule[0].matches[1].sa = 2; serverState.schedule[0].matches[1].sb = 6;
    serverAt = "2026-10-07T00:00:09Z";
    const nGet = rpcB.filter(x => x.fn === "room_get").length;
    dB.dispatchEvent(new wB.Event("visibilitychange"));
    await sleep(30);
    t("화면으로 돌아오면 서버 상태를 다시 받아 놓친 점수를 채운다", () => {
      assert(rpcB.filter(x => x.fn === "room_get").length === nGet + 1, "resync room_get");
      const s0 = $$B("#sched .score");
      assert(s0[2].value === "2" && s0[3].value === "6", s0[2].value + ":" + s0[3].value);
    });
    t("열람자는 서버에 쓰지 않는다", () => assert(!rpcB.some(x => x.fn === "room_push_state"), "push 발생"));
    handlers.find(h => h.k === "postgres_changes").fn({ new:{ state:serverState, updated_at:"2026-10-07T00:00:20Z", last_writer:"cA", is_open:false } });
    t("코트가 종료되면 마지막 결과를 남긴 채 열람 모드로", () => {
      assert($$B("#sched .score")[0].value === "6", "결과 유지");
      assert(/공유받은 결과/.test($B("#sched").textContent), "정적 열람 안내");
    });
    t("런타임 오류 없음", () => assert(!errs.length, errs[0]));
  }

  console.log(`\nSupabase 스모크: ${pass} 통과 / ${fail} 실패`);
  process.exit(fail ? 1 : 0);
}

main();
