// 실력 등급이 팀 전력 편차를 실제로 줄이는지 측정한다 (검증용, CI에는 넣지 않는다)
// 실행: npm run balance
const fs=require("fs"), {JSDOM}=require("jsdom");
const html=fs.readFileSync(require("path").join(__dirname,"..","index.html"),"utf8");
const dom=new JSDOM(html,{runScripts:"dangerously",pretendToBeVisual:true,url:"https://ex.com/t/"});
const w=dom.window,d=w.document; w.confirm=()=>true;
const $=s=>d.querySelector(s), $$=(s,r)=>[...(r||d).querySelectorAll(s)];
const click=e=>e.dispatchEvent(new w.MouseEvent("click",{bubbles:true}));
const LV=k=>k%3===0?2:(k%3===1?1:3);   // B, C, A 반복
function run(kind,partner,useLv,n,c,g){
  click($("#mode-change"));
  click($$("#intro button").find(b=>new RegExp(kind==="single"?"단식":"복식").test(b.textContent)));
  if(kind!=="single") click($$("#intro button").find(b=>new RegExp(kind==="mixed"?"혼성":"동성").test(b.textContent)));
  if(partner) click($$("#pt-seg button").find(b=>b.dataset.p===partner));
  click($$("#lv-seg button").find(b=>b.dataset.l===(useLv?"on":"off")));
  let guard=40; while(+$("#p-val").textContent>n&&guard--)click($("#p-minus"));
  while(+$("#p-val").textContent<n&&guard--)click($("#p-plus"));
  if(useLv) $$("#names .lvbtn").forEach((b,k)=>{for(let t=0;t<k%3;t++)click($$("#names .lvbtn")[k]);});
  click($$("#c-chips button").find(b=>+b.dataset.c===c));
  click($$("#r-chips button").find(b=>+b.dataset.r===g));
  $$("#names input").forEach((i,k)=>{i.value="p"+k;i.dispatchEvent(new w.Event("input",{bubbles:true}));});
  click($("#make"));
  let tot=0,cnt=0,mx=0;
  $$("#sched .court").forEach(ct=>{
    const [a,b]=$$(".nm",ct).map(e=>e.textContent.split("·").map(t=>+t.trim().replace(/^p/,"").replace(/[ABC]$/,"")));
    const s=a.reduce((x,i)=>x+LV(i),0)-b.reduce((x,i)=>x+LV(i),0);
    tot+=Math.abs(s);cnt++;mx=Math.max(mx,Math.abs(s));
  });
  return {avg:(tot/cnt).toFixed(2), max:mx, head:$("#sched p").textContent};
}
const cases=[["same",null,12,3,4],["same",null,8,2,4],["single",null,8,2,4],["mixed","random",12,3,4],["mixed","fixed",12,3,4]];
function avg3(kind,partner,useLv,n,c,g){
  let s=0,mx=0; for(let i=0;i<3;i++){const r=run(kind,partner,useLv,n,c,g); s+=+r.avg; mx=Math.max(mx,r.max);}
  return {avg:(s/3).toFixed(2),max:mx};
}
for(const [kind,partner,n,c,g] of cases){
  const off=avg3(kind,partner,false,n,c,g), on=avg3(kind,partner,true,n,c,g);
  console.log(`${kind}${partner?"/"+partner:""} n=${n} c=${c} g=${g}  등급 OFF 편차 ${off.avg} (최대 ${off.max})  →  ON ${on.avg} (최대 ${on.max})`);
}
