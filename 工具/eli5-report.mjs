#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const MAX_JSON = 1024 * 1024;
const MAX_HTML = 16 * MAX_JSON;
const MAX_HEAD = 256 * 1024;
const GENERATOR = 'eli5-report/1';
const DATA_TAG = '<script id="eli5-data" type="application/json">';
const STATES = ['正常','异常','待核'];
const SHAPES = {
  stats: ['label','value','unit'],
  items: ['label','state','input','rule','basis','action','exception'],
  decisions:['question','proposal'],
  evidence:['label','source'],
  terms:['term','meaning'],
};
const LIMITS = {stats:12,items:200,decisions:100,evidence:100,terms:100};
const esc = value => String(value).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
const jsonIsland = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0'));
const pending = value => value == null ? '待核' : value;
const refuse = message => { throw new Error(message); };
const object = value => value !== null && typeof value==='object' && !Array.isArray(value);

function parseJson(raw) {
  let value;
  try { value=JSON.parse(raw); } catch { refuse('JSON 语法无效'); }
  const containers=[], tokens=/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]]/g;
  for (const token of raw.matchAll(tokens)) {
    const text=token[0], head=text[0];
    if (head==='{') containers.push(new Set());
    else if (head==='[') containers.push(null);
    else if (head==='}' || head===']') containers.pop();
    else {
      const keys=containers.at(-1);
      if (!keys || !/^\s*:/.test(raw.slice(token.index+text.length))) continue;
      const name=JSON.parse(text);
      if (keys.has(name)) refuse('JSON 有重复键：'+name);
      keys.add(name);
    }
  }
  return value;
}

function sameFields(value, keys, at) {
  if (!object(value)) refuse(at+' 要填对象');
  for (const key of keys) if (!Object.hasOwn(value,key)) refuse(at+'.'+key+' 缺少');
  for (const key of Object.keys(value)) if (!keys.includes(key)) refuse(at+'.'+key+' 不是约定字段');
}
function text(value, at, {nullable=false,empty=false,max=2048}={}) {
  if (nullable && value===null) return value;
  if (typeof value!=='string' || (!empty && !value.trim()) || [...value].length>max ||
      /[[\p{Cc}\p{Cs}]--[\r\n\t]]/v.test(value)) refuse(at+' 要填可显示的文字'+(nullable?'或 null':''));
  return value;
}
function codePointOrder(a,b) {
  const aPoints=[...a], bPoints=[...b];
  for (let i=0; i<Math.min(aPoints.length,bPoints.length); i++) {
    const delta=aPoints[i].codePointAt(0)-bPoints[i].codePointAt(0);
    if (delta) return delta;
  }
  return aPoints.length-bPoints.length;
}
function batchText(batch) {
  return '参数｜'+Object.keys(batch).sort(codePointOrder).map(k=>k+'：'+batch[k]).join('｜');
}
function normalize(value) {
  sameFields(value,['batch','date','title','audience','conclusion',...Object.keys(SHAPES)],'数据');
  if (!object(value.batch) || !Object.keys(value.batch).length || Object.keys(value.batch).length>8)
    refuse('batch 要填 1–8 个批次参数');
  const batch = Object.fromEntries(Object.entries(value.batch).sort(([a],[b])=>codePointOrder(a,b)).map(([k,v])=>{
    for (const part of [text(k,'batch 键',{max:80}),text(v,'batch.'+k,{max:80})]) {
      if (part!==part.trim() || /[｜|：:\p{Cc}\p{Cf}\u2028\u2029]/u.test(part))
        refuse('batch 参数不能夹带分隔符、控制字符或两端空白');
    }
    return [k,v];
  }));
  const date=value.date;
  const instant=typeof date==='string' && new Date(date+'T00:00:00Z');
  if (!/^[0-9]{4}-\d\d-\d\d$/.test(date) || date.startsWith('0000') ||
      !instant || Number.isNaN(instant.valueOf()) || instant.toISOString().slice(0,10)!==date) refuse('date 要填真实日期 YYYY-MM-DD');
  const normalized={batch,date,title:text(value.title,'title'),audience:text(value.audience,'audience'),conclusion:text(value.conclusion,'conclusion')};
  for (const [field,keys] of Object.entries(SHAPES)) {
    const array=value[field];
    if (!Array.isArray(array) || array.length>LIMITS[field]) refuse(field+' 要填不超过 '+LIMITS[field]+' 项的数组');
    normalized[field]=array.map((item,i)=>{
      const at=field+'['+i+']';
      sameFields(item,keys,at);
      return Object.fromEntries(keys.map((k,j)=>{
        const v=item[k], loc=at+'.'+k;
        if (field==='stats' && k==='value') {
          if (v!==null && !Number.isFinite(v)) refuse(loc+' 要填有限数值或 null');
          return [k,v];
        }
        if (k==='state') {
          if (!STATES.includes(v)) refuse(loc+' 只能填正常、异常或待核');
          return [k,v];
        }
        return [k,text(v,loc,{nullable:j!==0&&k!=='unit',empty:k==='unit'})];
      }));
    });
  }
  return normalized;
}

const validFact = fact => typeof fact==='string' && !!fact.trim() && !/^待核(?:[：:]|$)/.test(fact.trim());
function effectiveState(item) {
  if (item.state==='待核' || ![item.input,item.rule,item.basis].every(validFact)) return '待核';
  return validFact(item.state==='正常'?item.action:item.exception) ? item.state : '待核';
}

const STYLE=`
@layer offline {
  :root{color-scheme:light dark;--foreground:#142d32;--muted-foreground:#496267;--card:#f9fcf9;--secondary:#e6efea;--border:#c5d9d1;--primary:#075a50;--primary-foreground:#fff;--accent-surface:#edf6ee;--success:#116246;--warning:#805412;--destructive:#a92f23;--radius:10px;--font-sans:system-ui,"Microsoft YaHei",sans-serif}
  @media(prefers-color-scheme:dark){:root{--foreground:#e5f4ef;--muted-foreground:#b0c9c5;--card:#1b2826;--secondary:#263e39;--border:#45665f;--primary:#89e1ce;--primary-foreground:#10342e;--accent-surface:#182e2b;--success:#9ce3b6;--warning:#ffd895;--destructive:#ffad9a}}
}
*{box-sizing:border-box}
body{margin:0;color:var(--foreground);font:1rem/1.55 var(--font-sans);overflow-wrap:anywhere}
main{width:min(100%,860px);margin-inline:auto}
header,nav,.detail,details,.feedback{margin-inline:.65rem}
header{margin-block:.65rem}h1,h2,p{margin:0}h1{font-size:1.48rem;line-height:1.3}h2{font-size:1.06rem}
.when,.conclusion,[data-visible-count]{font-size:.89rem;color:var(--muted-foreground)}
.conclusion{font-weight:600}
nav{display:flex;gap:.38rem;align-items:center;flex-wrap:wrap;margin-block:.45rem}
button,select,textarea{font:inherit;color:var(--foreground);background:var(--card);border:1px solid var(--border);border-radius:var(--radius)}
button{padding:.32rem .62rem;cursor:pointer}
button[aria-pressed=true],.copy{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
svg{display:block;width:100%;height:auto;font-family:var(--font-sans)}
.narrow{display:none}.paper{fill:var(--accent-surface)}.dot{fill:var(--border)}
.node{color:var(--muted-foreground)}
.good{color:var(--success)}.bad{color:var(--destructive)}.hold{color:var(--warning)}
.box{stroke:var(--border);fill:var(--card);stroke-width:2}
.node.active .box,.node:focus-visible .box{stroke:currentColor;stroke-width:3.2}
.node:not(.active) .box{fill:var(--accent-surface)}
svg text{text-anchor:middle;fill:var(--foreground);pointer-events:none}
svg [role=button]{cursor:pointer}
.label{font-size:19px;font-weight:720}
.number{fill:currentColor;font-size:22px;font-weight:750;font-variant-numeric:tabular-nums}
.edge{stroke:var(--border);stroke-width:2.2;fill:none}.edge.active{stroke:currentColor;stroke-width:4}
.edge-key{font-size:12px;fill:var(--muted-foreground);paint-order:stroke;stroke:var(--accent-surface);stroke-width:5px;stroke-linejoin:round}
.detail{padding-block:.48rem;font-size:.9rem}
.controls{display:flex;align-items:center;gap:.40rem;flex-wrap:wrap}
select{max-width:100%;min-width:0;padding:.22rem .35rem}
.sequence{margin:.33rem 0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.45rem}
.sequence div{min-width:0;border-top:2px solid var(--border);padding-top:.25rem}
dt{font-weight:700}dd{margin:0;color:var(--muted-foreground);white-space:pre-wrap}
details{border-block-start:1px solid var(--border);padding:.28rem 0;font-size:.88rem}
summary{cursor:pointer;font-weight:650}
details dl,details ul{margin:.35rem 0}details ul{padding-inline-start:1.2rem}
li{margin-block:.18rem}
.feedback{padding-bottom:.5rem;font-size:.87rem}
textarea{width:100%;max-width:100%;min-block-size:5rem;padding:.4rem}
[hidden]{display:none!important}
@media(max-width:510px){.wide{display:none}.narrow{display:block}.label{font-size:16px}}
`;

function scene(counts, narrow) {
  const suffix=narrow?'n':'w', width=narrow?390:728, height=narrow?474:452;
  const info = narrow ? {
    paths:['M195 96 V155','M155 225 C119 275 68 269 68 326','M195 228 V326','M235 225 C271 275 322 269 322 326'],
    legend:[[219,128],[97,281],[218,278],[298,281]],
    boxes:[[195,65,171,62],[195,194,178,70],[68,371,110,74],[195,371,110,74],[322,371,110,74]],
  } : {
    paths:['M174 217 H265','M395 196 C466 191 474 107 540 107','M401 217 H540','M395 239 C466 244 474 327 540 327'],
    legend:[[217,203],[473,143],[469,205],[472,291]],
    boxes:[[105,217,140,94],[337,217,130,92],[612,107,132,82],[612,217,132,82],[612,327,132,82]],
  };
  const labels=['当批输入','规则判断','正常交付','异常退回','待补证据'];
  const keys=['all','gate','正常','异常','待核'], colors=['','','good','bad','hold'];
  const lines=info.paths.map((d,i)=>{
    if (!(i===0?counts.all:counts[keys[i+1]])) return '';
    const [x,y]=info.legend[i];
    return '<path data-edge="" data-branch="'+keys[i+1]+'" class="edge active '+colors[i+1]+'" d="'+d+'" marker-end="url(#arrow-'+suffix+
      ')"/><text class="edge-key" x="'+x+'" y="'+y+'">'+['读入','交付','退回','补证'][i]+'</text>';
  }).join('');
  const boxes=info.boxes.map(([x,y,w,h],i)=>{
    const gate=i===1, state=keys[i], count=gate?'':counts[state];
    const box=gate?'<path class="box" d="M'+(-w/2+18)+' '+(-h/2)+'H'+(w/2-18)+'l18 18v'+(h-36)+'l-18 18H'+(-w/2+18)+'l-18 -18v'+(-(h-36))+'z"/>':
      '<rect class="box" x="'+(-w/2)+'" y="'+(-h/2)+'" width="'+w+'" height="'+h+'" rx="14"/>';
    const control=i>1?' role="button" tabindex="0" aria-label="筛选'+state+'"':'';
    return '<g data-node="'+state+'" class="node active '+colors[i]+'" transform="translate('+x+' '+y+')"'+control+'>'+box+
      '<text class="label" y="'+(gate?7:-6)+'">'+labels[i]+'</text>'+(gate?'':'<text class="number" y="22">'+count+'</text>')+'</g>';
  }).join('');
  return '<svg class="'+(narrow?'narrow':'wide')+'" viewBox="0 0 '+width+' '+height+'" aria-label="当批输入经规则判断流向正常、异常和待核">'+
    '<defs><pattern id="paper-'+suffix+'" width="19" height="19" patternUnits="userSpaceOnUse"><circle class="dot" cx="1" cy="1" r=".8"/></pattern>'+
    '<marker id="arrow-'+suffix+'" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path fill="context-stroke" d="M0 0L8 4L0 8Z"/></marker></defs>'+
    '<rect class="paper" width="'+width+'" height="'+height+'"/><rect fill="url(#paper-'+suffix+')" width="'+width+'" height="'+height+'"/>'+
    lines+boxes+'</svg>';
}

const SCRIPT=`
const data=JSON.parse(document.querySelector('#eli5-data').textContent);
const statuses=data.items.map(effectiveState);
const count=document.querySelector('[data-visible-count]');
const select=document.querySelector('#item');
const field=document.querySelector('textarea');
const status=document.querySelector('[data-copy-status]');
let filter='all', current=0;
function choose() {
  const section=document.querySelector('[data-item-panel]'), title=section.querySelector('#item-title');
  const fields=section.querySelectorAll('[data-item-field]');
  if (select.value==='') {
    current=-1;
    section.hidden=true;
    title.textContent='';
    for (const field of fields) field.textContent='';
    return;
  }
  current=Number(select.value);
  const x=data.items[current];
  section.hidden=false;
  title.textContent=x.label+' · '+statuses[current];
  for (const field of fields) {
    const value=x[field.dataset.itemField];
    field.textContent=validFact(value) ? value : '待核';
  }
}
function show() {
  const rows=data.items.flatMap((x,i)=>filter==='all'||statuses[i]===filter?[i]:[]);
  for(const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed',String(b.dataset.filter===filter));
  count.textContent='可见 '+rows.length+' / 全批 '+data.items.length+' 条';
  document.querySelector('[data-empty]').hidden=!!rows.length;
  document.querySelector('[data-empty]').textContent=data.items.length?'这一类没有记录。':'本批没有逐项记录';
  document.querySelector('[data-pick]').hidden=!rows.length;
  for(const node of document.querySelectorAll('[data-node]')) {
    const key=node.dataset.node;
    const active=filter==='all'||['all','gate',filter].includes(key);
    node.classList.toggle('active',active);
    if(node.hasAttribute('role')) node.setAttribute('aria-pressed',String(key===filter));
  }
  for(const edge of document.querySelectorAll('[data-edge]'))
    edge.classList.toggle('active',filter==='all'||['gate',filter].includes(edge.dataset.branch));
  select.replaceChildren(...rows.map(i=>new Option(data.items[i].label,i)));
  select.value=String(rows.includes(current)?current:rows[0] ?? '');
  choose();
}
select.addEventListener('change',choose);
const filterTo=state=>{filter=state;show();};
document.querySelector('[data-visual]').addEventListener('click',e=>{
  const target=e.target.closest('[role="button"][data-node]');if(target)filterTo(target.dataset.node);
});
document.querySelector('[data-visual]').addEventListener('keydown',e=>{
  const target=e.target.closest('[role="button"][data-node]');
  if(target&&(e.key==='Enter'||e.key===' ')){e.preventDefault();filterTo(target.dataset.node);}
});
document.addEventListener('click',async e=>{
  const button=e.target.closest('button');if(!button)return;
  if(button.dataset.filter)filterTo(button.dataset.filter);
  if(button.dataset.copy===undefined)return;
  const decision=data.decisions[Number(button.dataset.copy)];
  const one=s=>String(s ?? '待核').replace(/[\\p{Cc}\\p{Cf}\\u2028\\u2029]+/gu,' ').trim();
  const batch=document.querySelector('meta[name="coach-batch"]').content;
  const instruction='请按「'+one(data.title)+'」的批次「'+batch+'」和我核对「'+one(decision.question)+'」。建议：'+one(decision.proposal)+'。请列依据和影响，等我确认再执行。';
  try{await navigator.clipboard.writeText(instruction);field.hidden=true;status.textContent='已复制';}
  catch{field.value=instruction;field.hidden=false;field.focus();field.select();status.textContent='已全选，请复制';}
});
show();
`;

function listDetails(title,items,render) {
  return '<details><summary>'+title+'</summary>'+(items.length?'<ul>'+items.map(render).join('')+'</ul>':'<p>本批无登记。</p>')+'</details>';
}
function render(data) {
  const counts={all:data.items.length,正常:0,异常:0,待核:0};
  for (const item of data.items) counts[effectiveState(item)]++;
  const controls=[['all','全部'],...STATES.map(s=>[s,s])].map(([key,label])=>
    '<button type="button" data-filter="'+key+'" aria-pressed="'+(key==='all')+'">'+label+'</button>').join('');
  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta name="coach-generator" content="'+GENERATOR+'"><meta name="coach-batch" content="'+esc(batchText(data.batch))+'">'+
    '<title>'+esc(data.title)+'</title><style>'+STYLE+'</style></head><body><main>'+
    '<header><p class="when">'+data.date+' · '+esc(data.audience)+'</p><h1>'+esc(data.title)+'</h1><p class="conclusion">'+esc(data.conclusion)+'</p></header>'+
    '<nav aria-label="筛选本批条目">'+controls+'<span data-visible-count aria-live="polite"></span></nav>'+
    '<div data-visual>'+scene(counts,false)+scene(counts,true)+'</div>'+
    '<div class="detail"><p data-empty'+(counts.all?' hidden':'')+'>本批没有逐项记录</p>'+
    '<div class="controls" data-pick><label for="item">查看一条</label><select id="item"></select></div>'+
    '<section data-item-panel><h2 id="item-title"></h2><dl class="sequence">'+
    '<div><dt>进门</dt><dd data-item-field="input"></dd></div>'+
    '<div><dt>判断与依据</dt><dd data-item-field="rule"></dd><dd data-item-field="basis"></dd></div>'+
    '<div><dt>去向／异常</dt><dd data-item-field="action"></dd><dd data-item-field="exception"></dd></div></dl></section></div>'+
    listDetails('本批统计',data.stats,x=>'<li>'+esc(x.label)+' · '+esc(pending(x.value))+(x.value===null?'':esc(x.unit))+'</li>')+
    listDetails('证据与出处',data.evidence,x=>'<li>'+esc(x.label)+' · '+esc(pending(x.source))+'</li>')+
    listDetails('术语',data.terms,x=>'<li>'+esc(x.term)+' · '+esc(pending(x.meaning))+'</li>')+
    listDetails('待拍板事项',data.decisions,(x,i)=>'<li><strong>'+esc(x.question)+'</strong><p>'+esc(pending(x.proposal))+
      '</p><button type="button" class="copy" data-copy="'+i+'">复制给 AI</button></li>')+
    '<div class="feedback"><p role="status" data-copy-status></p><textarea readonly hidden aria-label="复制用指令"></textarea></div></main>'+
    DATA_TAG+jsonIsland(data)+'</script><script>const validFact='+validFact.toString()+';\n'+effectiveState.toString()+'\n'+SCRIPT+'</script></body></html>\n';
}

// A bounded head tokenizer reads metadata as data. Raw text and template bodies cannot declare it.
const HEAD_TAGS = new Set(['title','meta','base','link','script','style','template','noscript']);
function headMeta(text, wanted) {
  const tags = /<!--[\s\S]*?(?:-->|$)|<!doctype\b[^>]*>|<(\/?)([a-z][\w:-]*)(\s*(?:"[^"]*"|'[^']*'|[^'"<>])*)>/gi;
  let inHead = false, inTemplate = 0, consumed = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const matches = [];
  for (let tok; (tok=tags.exec(text)); consumed=tags.lastIndex) {
    if (!inTemplate && /[^ \t\n\f\r]/.test(text.slice(consumed,tok.index))) return {matches,ended:true};
    const [,closing,rawName,attrs] = tok;
    if (!rawName) continue;
    const name=rawName.toLowerCase();
    if (!inHead) {
      if (name==='head' && !closing) { inHead=true; continue; }
      if (name==='html' && !closing) continue;
      if (!closing && HEAD_TAGS.has(name)) inHead=true;
      else return {matches,ended:true};
    }
    if (!inTemplate && !HEAD_TAGS.has(name) && !(name==='head' && !closing))
      return {matches,ended:true};
    if (name==='template') { inTemplate=Math.max(0,inTemplate+(closing?-1:1)); continue; }
    if (!closing && ['script','style','title','noscript'].includes(name)) {
      const close=new RegExp('</'+name+'\\s*>','ig');
      close.lastIndex=tags.lastIndex;
      if (!close.exec(text)) break;
      tags.lastIndex=close.lastIndex;
      continue;
    }
    if (inTemplate || name!=='meta' || closing) continue;
    const fields=new Map();
    for (const a of attrs.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const key=a[1].toLowerCase();
      if (!fields.has(key)) fields.set(key,[]);
      fields.get(key).push(htmlValue(a[2] ?? a[3] ?? a[4] ?? ''));
    }
    if (fields.get('name')?.some(x=>x.toLowerCase()===wanted))
      matches.push({value:fields.get('content')?.[0] ?? '', valid:fields.get('name').length===1 && fields.get('content')?.length===1});
  }
  return {matches,ended:false};
}
// WHATWG entities.json. Each record is hex code point(s) followed by case-sensitive names.
const htmlEntities=new Map();
for (const record of `c6:AElig 26:AMP:amp c1:Aacute 102:Abreve c2:Acirc 410:Acy 1d504:Afr c0:Agrave 391:Alpha 100:Amacr 2a53:And
104:Aogon 1d538:Aopf 2061:ApplyFunction:af c5:Aring:angst 1d49c:Ascr 2254:Assign:colone:coloneq c3:Atilde
c4:Auml 2216:Backslash:setminus:setmn:smallsetminus:ssetmn 2ae7:Barv 2306:Barwed:doublebarwedge 411:Bcy
2235:Because:becaus:because 212c:Bernoullis:Bscr:bernou 392:Beta 1d505:Bfr 1d539:Bopf 2d8:Breve:breve
224e:Bumpeq:HumpDownHump:bump 427:CHcy a9:COPY:copy 106:Cacute 22d2:Cap 2145:CapitalDifferentialD:DD
212d:Cayleys:Cfr 10c:Ccaron c7:Ccedil 108:Ccirc 2230:Cconint 10a:Cdot b8:Cedilla:cedil
b7:CenterDot:centerdot:middot 3a7:Chi 2299:CircleDot:odot 2296:CircleMinus:ominus 2295:CirclePlus:oplus
2297:CircleTimes:otimes 2232:ClockwiseContourIntegral:cwconint 201d:CloseCurlyDoubleQuote:rdquo:rdquor
2019:CloseCurlyQuote:rsquo:rsquor 2237:Colon:Proportion 2a74:Colone 2261:Congruent:equiv
222f:Conint:DoubleContourIntegral 222e:ContourIntegral:conint:oint 2102:Copf:complexes 2210:Coproduct:coprod
2233:CounterClockwiseContourIntegral:awconint 2a2f:Cross 1d49e:Cscr 22d3:Cup 224d:CupCap:asympeq 2911:DDotrahd
402:DJcy 405:DScy 40f:DZcy 2021:Dagger:ddagger 21a1:Darr 2ae4:Dashv:DoubleLeftTee 10e:Dcaron 414:Dcy
2207:Del:nabla 394:Delta 1d507:Dfr b4:DiacriticalAcute:acute 2d9:DiacriticalDot:dot
2dd:DiacriticalDoubleAcute:dblac 60:DiacriticalGrave:grave 2dc:DiacriticalTilde:tilde 22c4:Diamond:diam:diamond
2146:DifferentialD:dd 1d53b:Dopf a8:Dot:DoubleDot:die:uml 20dc:DotDot 2250:DotEqual:doteq:esdot
21d3:DoubleDownArrow:Downarrow:dArr 21d0:DoubleLeftArrow:Leftarrow:lArr
21d4:DoubleLeftRightArrow:Leftrightarrow:hArr:iff 27f8:DoubleLongLeftArrow:Longleftarrow:xlArr
27fa:DoubleLongLeftRightArrow:Longleftrightarrow:xhArr 27f9:DoubleLongRightArrow:Longrightarrow:xrArr
21d2:DoubleRightArrow:Implies:Rightarrow:rArr 22a8:DoubleRightTee:vDash 21d1:DoubleUpArrow:Uparrow:uArr
21d5:DoubleUpDownArrow:Updownarrow:vArr 2225:DoubleVerticalBar:par:parallel:shortparallel:spar
2193:DownArrow:ShortDownArrow:darr:downarrow 2913:DownArrowBar 21f5:DownArrowUpArrow:duarr 311:DownBreve
2950:DownLeftRightVector 295e:DownLeftTeeVector 21bd:DownLeftVector:leftharpoondown:lhard 2956:DownLeftVectorBar
295f:DownRightTeeVector 21c1:DownRightVector:rhard:rightharpoondown 2957:DownRightVectorBar 22a4:DownTee:top
21a7:DownTeeArrow:mapstodown 1d49f:Dscr 110:Dstrok 14a:ENG d0:ETH c9:Eacute 11a:Ecaron ca:Ecirc 42d:Ecy 116:Edot
1d508:Efr c8:Egrave 2208:Element:in:isin:isinv 112:Emacr 25fb:EmptySmallSquare 25ab:EmptyVerySmallSquare
118:Eogon 1d53c:Eopf 395:Epsilon 2a75:Equal 2242:EqualTilde:eqsim:esim 21cc:Equilibrium:rightleftharpoons:rlhar
2130:Escr:expectation 2a73:Esim 397:Eta cb:Euml 2203:Exists:exist 2147:ExponentialE:ee:exponentiale 424:Fcy
1d509:Ffr 25fc:FilledSmallSquare 25aa:FilledVerySmallSquare:blacksquare:squarf:squf 1d53d:Fopf
2200:ForAll:forall 2131:Fouriertrf:Fscr 403:GJcy 3e:GT:gt 393:Gamma 3dc:Gammad 11e:Gbreve 122:Gcedil 11c:Gcirc
413:Gcy 120:Gdot 1d50a:Gfr 22d9:Gg:ggg 1d53e:Gopf 2265:GreaterEqual:ge:geq 22db:GreaterEqualLess:gel:gtreqless
2267:GreaterFullEqual:gE:geqq 2aa2:GreaterGreater 2277:GreaterLess:gl:gtrless
2a7e:GreaterSlantEqual:geqslant:ges 2273:GreaterTilde:gsim:gtrsim 1d4a2:Gscr 226b:Gt:NestedGreaterGreater:gg
42a:HARDcy 2c7:Hacek:caron 5e:Hat 124:Hcirc 210c:Hfr:Poincareplane 210b:HilbertSpace:Hscr:hamilt
210d:Hopf:quaternions 2500:HorizontalLine:boxh 126:Hstrok 224f:HumpEqual:bumpe:bumpeq 415:IEcy 132:IJlig
401:IOcy cd:Iacute ce:Icirc 418:Icy 130:Idot 2111:Ifr:Im:image:imagpart cc:Igrave 12a:Imacr 2148:ImaginaryI:ii
222c:Int 222b:Integral:int 22c2:Intersection:bigcap:xcap 2063:InvisibleComma:ic 2062:InvisibleTimes:it 12e:Iogon
1d540:Iopf 399:Iota 2110:Iscr:imagline 128:Itilde 406:Iukcy cf:Iuml 134:Jcirc 419:Jcy 1d50d:Jfr 1d541:Jopf
1d4a5:Jscr 408:Jsercy 404:Jukcy 425:KHcy 40c:KJcy 39a:Kappa 136:Kcedil 41a:Kcy 1d50e:Kfr 1d542:Kopf 1d4a6:Kscr
409:LJcy 3c:LT:lt 139:Lacute 39b:Lambda 27ea:Lang 2112:Laplacetrf:Lscr:lagran 219e:Larr:twoheadleftarrow
13d:Lcaron 13b:Lcedil 41b:Lcy 27e8:LeftAngleBracket:lang:langle
2190:LeftArrow:ShortLeftArrow:larr:leftarrow:slarr 21e4:LeftArrowBar:larrb
21c6:LeftArrowRightArrow:leftrightarrows:lrarr 2308:LeftCeiling:lceil 27e6:LeftDoubleBracket:lobrk
2961:LeftDownTeeVector 21c3:LeftDownVector:dharl:downharpoonleft 2959:LeftDownVectorBar 230a:LeftFloor:lfloor
2194:LeftRightArrow:harr:leftrightarrow 294e:LeftRightVector 22a3:LeftTee:dashv 21a4:LeftTeeArrow:mapstoleft
295a:LeftTeeVector 22b2:LeftTriangle:vartriangleleft:vltri 29cf:LeftTriangleBar
22b4:LeftTriangleEqual:ltrie:trianglelefteq 2951:LeftUpDownVector 2960:LeftUpTeeVector
21bf:LeftUpVector:uharl:upharpoonleft 2958:LeftUpVectorBar 21bc:LeftVector:leftharpoonup:lharu
2952:LeftVectorBar 22da:LessEqualGreater:leg:lesseqgtr 2266:LessFullEqual:lE:leqq 2276:LessGreater:lessgtr:lg
2aa1:LessLess 2a7d:LessSlantEqual:leqslant:les 2272:LessTilde:lesssim:lsim 1d50f:Lfr 22d8:Ll
21da:Lleftarrow:lAarr 13f:Lmidot 27f5:LongLeftArrow:longleftarrow:xlarr
27f7:LongLeftRightArrow:longleftrightarrow:xharr 27f6:LongRightArrow:longrightarrow:xrarr 1d543:Lopf
2199:LowerLeftArrow:swarr:swarrow 2198:LowerRightArrow:searr:searrow 21b0:Lsh:lsh 141:Lstrok
226a:Lt:NestedLessLess:ll 2905:Map 41c:Mcy 205f:MediumSpace 2133:Mellintrf:Mscr:phmmat 1d510:Mfr
2213:MinusPlus:mnplus:mp 1d544:Mopf 39c:Mu 40a:NJcy 143:Nacute 147:Ncaron 145:Ncedil 41d:Ncy
200b:NegativeMediumSpace:NegativeThickSpace:NegativeThinSpace:NegativeVeryThinSpace:ZeroWidthSpace a:NewLine
1d511:Nfr 2060:NoBreak a0:NonBreakingSpace:nbsp 2115:Nopf:naturals 2aec:Not 2262:NotCongruent:nequiv
226d:NotCupCap 2226:NotDoubleVerticalBar:npar:nparallel:nshortparallel:nspar 2209:NotElement:notin:notinva
2260:NotEqual:ne 2242,338:NotEqualTilde:nesim 2204:NotExists:nexist:nexists 226f:NotGreater:ngt:ngtr
2271:NotGreaterEqual:nge:ngeq 2267,338:NotGreaterFullEqual:ngE:ngeqq 226b,338:NotGreaterGreater:nGtv
2279:NotGreaterLess:ntgl 2a7e,338:NotGreaterSlantEqual:ngeqslant:nges 2275:NotGreaterTilde:ngsim
224e,338:NotHumpDownHump:nbump 224f,338:NotHumpEqual:nbumpe 22ea:NotLeftTriangle:nltri:ntriangleleft
29cf,338:NotLeftTriangleBar 22ec:NotLeftTriangleEqual:nltrie:ntrianglelefteq 226e:NotLess:nless:nlt
2270:NotLessEqual:nle:nleq 2278:NotLessGreater:ntlg 226a,338:NotLessLess:nLtv
2a7d,338:NotLessSlantEqual:nleqslant:nles 2274:NotLessTilde:nlsim 2aa2,338:NotNestedGreaterGreater
2aa1,338:NotNestedLessLess 2280:NotPrecedes:npr:nprec 2aaf,338:NotPrecedesEqual:npre:npreceq
22e0:NotPrecedesSlantEqual:nprcue 220c:NotReverseElement:notni:notniva
22eb:NotRightTriangle:nrtri:ntriangleright 29d0,338:NotRightTriangleBar
22ed:NotRightTriangleEqual:nrtrie:ntrianglerighteq 228f,338:NotSquareSubset 22e2:NotSquareSubsetEqual:nsqsube
2290,338:NotSquareSuperset 22e3:NotSquareSupersetEqual:nsqsupe 2282,20d2:NotSubset:nsubset:vnsub
2288:NotSubsetEqual:nsube:nsubseteq 2281:NotSucceeds:nsc:nsucc 2ab0,338:NotSucceedsEqual:nsce:nsucceq
22e1:NotSucceedsSlantEqual:nsccue 227f,338:NotSucceedsTilde 2283,20d2:NotSuperset:nsupset:vnsup
2289:NotSupersetEqual:nsupe:nsupseteq 2241:NotTilde:nsim 2244:NotTildeEqual:nsime:nsimeq
2247:NotTildeFullEqual:ncong 2249:NotTildeTilde:nap:napprox 2224:NotVerticalBar:nmid:nshortmid:nsmid 1d4a9:Nscr
d1:Ntilde 39d:Nu 152:OElig d3:Oacute d4:Ocirc 41e:Ocy 150:Odblac 1d512:Ofr d2:Ograve 14c:Omacr 3a9:Omega:ohm
39f:Omicron 1d546:Oopf 201c:OpenCurlyDoubleQuote:ldquo 2018:OpenCurlyQuote:lsquo 2a54:Or 1d4aa:Oscr d8:Oslash
d5:Otilde 2a37:Otimes d6:Ouml 203e:OverBar:oline 23de:OverBrace 23b4:OverBracket:tbrk 23dc:OverParenthesis
2202:PartialD:part 41f:Pcy 1d513:Pfr 3a6:Phi 3a0:Pi b1:PlusMinus:plusmn:pm 2119:Popf:primes 2abb:Pr
227a:Precedes:pr:prec 2aaf:PrecedesEqual:pre:preceq 227c:PrecedesSlantEqual:prcue:preccurlyeq
227e:PrecedesTilde:precsim:prsim 2033:Prime 220f:Product:prod 221d:Proportional:prop:propto:varpropto:vprop
1d4ab:Pscr 3a8:Psi 22:QUOT:quot 1d514:Qfr 211a:Qopf:rationals 1d4ac:Qscr 2910:RBarr:drbkarow ae:REG:circledR:reg
154:Racute 27eb:Rang 21a0:Rarr:twoheadrightarrow 2916:Rarrtl 158:Rcaron 156:Rcedil 420:Rcy
211c:Re:Rfr:real:realpart 220b:ReverseElement:SuchThat:ni:niv 21cb:ReverseEquilibrium:leftrightharpoons:lrhar
296f:ReverseUpEquilibrium:duhar 3a1:Rho 27e9:RightAngleBracket:rang:rangle
2192:RightArrow:ShortRightArrow:rarr:rightarrow:srarr 21e5:RightArrowBar:rarrb
21c4:RightArrowLeftArrow:rightleftarrows:rlarr 2309:RightCeiling:rceil 27e7:RightDoubleBracket:robrk
295d:RightDownTeeVector 21c2:RightDownVector:dharr:downharpoonright 2955:RightDownVectorBar
230b:RightFloor:rfloor 22a2:RightTee:vdash 21a6:RightTeeArrow:map:mapsto 295b:RightTeeVector
22b3:RightTriangle:vartriangleright:vrtri 29d0:RightTriangleBar 22b5:RightTriangleEqual:rtrie:trianglerighteq
294f:RightUpDownVector 295c:RightUpTeeVector 21be:RightUpVector:uharr:upharpoonright 2954:RightUpVectorBar
21c0:RightVector:rharu:rightharpoonup 2953:RightVectorBar 211d:Ropf:reals 2970:RoundImplies
21db:Rrightarrow:rAarr 211b:Rscr:realine 21b1:Rsh:rsh 29f4:RuleDelayed 429:SHCHcy 428:SHcy 42c:SOFTcy 15a:Sacute
2abc:Sc 160:Scaron 15e:Scedil 15c:Scirc 421:Scy 1d516:Sfr 2191:ShortUpArrow:UpArrow:uarr:uparrow 3a3:Sigma
2218:SmallCircle:compfn 1d54a:Sopf 221a:Sqrt:radic 25a1:Square:squ:square 2293:SquareIntersection:sqcap
228f:SquareSubset:sqsub:sqsubset 2291:SquareSubsetEqual:sqsube:sqsubseteq 2290:SquareSuperset:sqsup:sqsupset
2292:SquareSupersetEqual:sqsupe:sqsupseteq 2294:SquareUnion:sqcup 1d4ae:Sscr 22c6:Star:sstarf 22d0:Sub:Subset
2286:SubsetEqual:sube:subseteq 227b:Succeeds:sc:succ 2ab0:SucceedsEqual:sce:succeq
227d:SucceedsSlantEqual:sccue:succcurlyeq 227f:SucceedsTilde:scsim:succsim 2211:Sum:sum 22d1:Sup:Supset
2283:Superset:sup:supset 2287:SupersetEqual:supe:supseteq de:THORN 2122:TRADE:trade 40b:TSHcy 426:TScy 9:Tab
3a4:Tau 164:Tcaron 162:Tcedil 422:Tcy 1d517:Tfr 2234:Therefore:there4:therefore 398:Theta 205f,200a:ThickSpace
2009:ThinSpace:thinsp 223c:Tilde:sim:thicksim:thksim 2243:TildeEqual:sime:simeq 2245:TildeFullEqual:cong
2248:TildeTilde:ap:approx:asymp:thickapprox:thkap 1d54b:Topf 20db:TripleDot:tdot 1d4af:Tscr 166:Tstrok da:Uacute
219f:Uarr 2949:Uarrocir 40e:Ubrcy 16c:Ubreve db:Ucirc 423:Ucy 170:Udblac 1d518:Ufr d9:Ugrave 16a:Umacr
5f:UnderBar:lowbar 23df:UnderBrace 23b5:UnderBracket:bbrk 23dd:UnderParenthesis 22c3:Union:bigcup:xcup
228e:UnionPlus:uplus 172:Uogon 1d54c:Uopf 2912:UpArrowBar 21c5:UpArrowDownArrow:udarr
2195:UpDownArrow:updownarrow:varr 296e:UpEquilibrium:udhar 22a5:UpTee:bot:bottom:perp 21a5:UpTeeArrow:mapstoup
2196:UpperLeftArrow:nwarr:nwarrow 2197:UpperRightArrow:nearr:nearrow 3d2:Upsi:upsih 3a5:Upsilon 16e:Uring
1d4b0:Uscr 168:Utilde dc:Uuml 22ab:VDash 2aeb:Vbar 412:Vcy 22a9:Vdash 2ae6:Vdashl 22c1:Vee:bigvee:xvee
2016:Verbar:Vert 2223:VerticalBar:mid:shortmid:smid 7c:VerticalLine:verbar:vert 2758:VerticalSeparator
2240:VerticalTilde:wr:wreath 200a:VeryThinSpace:hairsp 1d519:Vfr 1d54d:Vopf 1d4b1:Vscr 22aa:Vvdash 174:Wcirc
22c0:Wedge:bigwedge:xwedge 1d51a:Wfr 1d54e:Wopf 1d4b2:Wscr 1d51b:Xfr 39e:Xi 1d54f:Xopf 1d4b3:Xscr 42f:YAcy
407:YIcy 42e:YUcy dd:Yacute 176:Ycirc 42b:Ycy 1d51c:Yfr 1d550:Yopf 1d4b4:Yscr 178:Yuml 416:ZHcy 179:Zacute
17d:Zcaron 417:Zcy 17b:Zdot 396:Zeta 2128:Zfr:zeetrf 2124:Zopf:integers 1d4b5:Zscr e1:aacute 103:abreve
223e:ac:mstpos 223e,333:acE 223f:acd e2:acirc 430:acy e6:aelig 1d51e:afr e0:agrave 2135:alefsym:aleph 3b1:alpha
101:amacr 2a3f:amalg 2227:and:wedge 2a55:andand 2a5c:andd 2a58:andslope 2a5a:andv 2220:ang:angle 29a4:ange
2221:angmsd:measuredangle 29a8:angmsdaa 29a9:angmsdab 29aa:angmsdac 29ab:angmsdad 29ac:angmsdae 29ad:angmsdaf
29ae:angmsdag 29af:angmsdah 221f:angrt 22be:angrtvb 299d:angrtvbd 2222:angsph 237c:angzarr 105:aogon 1d552:aopf
2a70:apE 2a6f:apacir 224a:ape:approxeq 224b:apid 27:apos e5:aring 1d4b6:ascr 2a:ast:midast e3:atilde e4:auml
2a11:awint 2aed:bNot 224c:backcong:bcong 3f6:backepsilon:bepsi 2035:backprime:bprime 223d:backsim:bsim
22cd:backsimeq:bsime 22bd:barvee 2305:barwed:barwedge 23b6:bbrktbrk 431:bcy 201e:bdquo:ldquor 29b0:bemptyv
3b2:beta 2136:beth 226c:between:twixt 1d51f:bfr 25ef:bigcirc:xcirc 2a00:bigodot:xodot 2a01:bigoplus:xoplus
2a02:bigotimes:xotime 2a06:bigsqcup:xsqcup 2605:bigstar:starf 25bd:bigtriangledown:xdtri
25b3:bigtriangleup:xutri 2a04:biguplus:xuplus 290d:bkarow:rbarr 29eb:blacklozenge:lozf 25b4:blacktriangle:utrif
25be:blacktriangledown:dtrif 25c2:blacktriangleleft:ltrif 25b8:blacktriangleright:rtrif 2423:blank 2592:blk12
2591:blk14 2593:blk34 2588:block 3d,20e5:bne 2261,20e5:bnequiv 2310:bnot 1d553:bopf 22c8:bowtie 2557:boxDL
2554:boxDR 2556:boxDl 2553:boxDr 2550:boxH 2566:boxHD 2569:boxHU 2564:boxHd 2567:boxHu 255d:boxUL 255a:boxUR
255c:boxUl 2559:boxUr 2551:boxV 256c:boxVH 2563:boxVL 2560:boxVR 256b:boxVh 2562:boxVl 255f:boxVr 29c9:boxbox
2555:boxdL 2552:boxdR 2510:boxdl 250c:boxdr 2565:boxhD 2568:boxhU 252c:boxhd 2534:boxhu 229f:boxminus:minusb
229e:boxplus:plusb 22a0:boxtimes:timesb 255b:boxuL 2558:boxuR 2518:boxul 2514:boxur 2502:boxv 256a:boxvH
2561:boxvL 255e:boxvR 253c:boxvh 2524:boxvl 251c:boxvr a6:brvbar 1d4b7:bscr 204f:bsemi 5c:bsol 29c5:bsolb
27c8:bsolhsub 2022:bull:bullet 2aae:bumpE 107:cacute 2229:cap 2a44:capand 2a49:capbrcup 2a4b:capcap 2a47:capcup
2a40:capdot 2229,fe00:caps 2041:caret 2a4d:ccaps 10d:ccaron e7:ccedil 109:ccirc 2a4c:ccups 2a50:ccupssm 10b:cdot
29b2:cemptyv a2:cent 1d520:cfr 447:chcy 2713:check:checkmark 3c7:chi 25cb:cir 29c3:cirE 2c6:circ
2257:circeq:cire 21ba:circlearrowleft:olarr 21bb:circlearrowright:orarr 24c8:circledS:oS 229b:circledast:oast
229a:circledcirc:ocir 229d:circleddash:odash 2a10:cirfnint 2aef:cirmid 29c2:cirscir 2663:clubs:clubsuit 3a:colon
2c:comma 40:commat 2201:comp:complement 2a6d:congdot 1d554:copf 2117:copysr 21b5:crarr 2717:cross 1d4b8:cscr
2acf:csub 2ad1:csube 2ad0:csup 2ad2:csupe 22ef:ctdot 2938:cudarrl 2935:cudarrr 22de:cuepr:curlyeqprec
22df:cuesc:curlyeqsucc 21b6:cularr:curvearrowleft 293d:cularrp 222a:cup 2a48:cupbrcap 2a46:cupcap 2a4a:cupcup
228d:cupdot 2a45:cupor 222a,fe00:cups 21b7:curarr:curvearrowright 293c:curarrm 22ce:curlyvee:cuvee
22cf:curlywedge:cuwed a4:curren 2231:cwint 232d:cylcty 2965:dHar 2020:dagger 2138:daleth 2010:dash:hyphen
290f:dbkarow:rBarr 10f:dcaron 434:dcy 21ca:ddarr:downdownarrows 2a77:ddotseq:eDDot b0:deg 3b4:delta 29b1:demptyv
297f:dfisht 1d521:dfr 2666:diamondsuit:diams 3dd:digamma:gammad 22f2:disin f7:div:divide
22c7:divideontimes:divonx 452:djcy 231e:dlcorn:llcorner 230d:dlcrop 24:dollar 1d555:dopf 2251:doteqdot:eDot
2238:dotminus:minusd 2214:dotplus:plusdo 22a1:dotsquare:sdotb 231f:drcorn:lrcorner 230c:drcrop 1d4b9:dscr
455:dscy 29f6:dsol 111:dstrok 22f1:dtdot 25bf:dtri:triangledown 29a6:dwangle 45f:dzcy 27ff:dzigrarr e9:eacute
2a6e:easter 11b:ecaron 2256:ecir:eqcirc ea:ecirc 2255:ecolon:eqcolon 44d:ecy 117:edot 2252:efDot:fallingdotseq
1d522:efr 2a9a:eg e8:egrave 2a96:egs:eqslantgtr 2a98:egsdot 2a99:el 23e7:elinters 2113:ell 2a95:els:eqslantless
2a97:elsdot 113:emacr 2205:empty:emptyset:emptyv:varnothing 2004:emsp13 2005:emsp14 2003:emsp 14b:eng 2002:ensp
119:eogon 1d556:eopf 22d5:epar 29e3:eparsl 2a71:eplus 3b5:epsi:epsilon 3f5:epsiv:straightepsilon:varepsilon
3d:equals 225f:equest:questeq 2a78:equivDD 29e5:eqvparsl 2253:erDot:risingdotseq 2971:erarr 212f:escr 3b7:eta
f0:eth eb:euml 20ac:euro 21:excl 444:fcy 2640:female fb03:ffilig fb00:fflig fb04:ffllig 1d523:ffr fb01:filig
66,6a:fjlig 266d:flat fb02:fllig 25b1:fltns 192:fnof 1d557:fopf 22d4:fork:pitchfork 2ad9:forkv 2a0d:fpartint
bd:frac12:half 2153:frac13 bc:frac14 2155:frac15 2159:frac16 215b:frac18 2154:frac23 2156:frac25 be:frac34
2157:frac35 215c:frac38 2158:frac45 215a:frac56 215d:frac58 215e:frac78 2044:frasl 2322:frown:sfrown 1d4bb:fscr
2a8c:gEl:gtreqqless 1f5:gacute 3b3:gamma 2a86:gap:gtrapprox 11f:gbreve 11d:gcirc 433:gcy 121:gdot 2aa9:gescc
2a80:gesdot 2a82:gesdoto 2a84:gesdotol 22db,fe00:gesl 2a94:gesles 1d524:gfr 2137:gimel 453:gjcy 2a92:glE
2aa5:gla 2aa4:glj 2269:gnE:gneqq 2a8a:gnap:gnapprox 2a88:gne:gneq 22e7:gnsim 1d558:gopf 210a:gscr 2a8e:gsime
2a90:gsiml 2aa7:gtcc 2a7a:gtcir 22d7:gtdot:gtrdot 2995:gtlPar 2a7c:gtquest 2978:gtrarr 2269,fe00:gvertneqq:gvnE
44a:hardcy 2948:harrcir 21ad:harrw:leftrightsquigarrow 210f:hbar:hslash:planck:plankv 125:hcirc
2665:hearts:heartsuit 2026:hellip:mldr 22b9:hercon 1d525:hfr 2925:hksearow:searhk 2926:hkswarow:swarhk
21ff:hoarr 223b:homtht 21a9:hookleftarrow:larrhk 21aa:hookrightarrow:rarrhk 1d559:hopf 2015:horbar 1d4bd:hscr
127:hstrok 2043:hybull ed:iacute ee:icirc 438:icy 435:iecy a1:iexcl 1d526:ifr ec:igrave 2a0c:iiiint:qint
222d:iiint:tint 29dc:iinfin 2129:iiota 133:ijlig 12b:imacr 131:imath:inodot 22b7:imof 1b5:imped 2105:incare
221e:infin 29dd:infintie 22ba:intcal:intercal 2a17:intlarhk 2a3c:intprod:iprod 451:iocy 12f:iogon 1d55a:iopf
3b9:iota bf:iquest 1d4be:iscr 22f9:isinE 22f5:isindot 22f4:isins 22f3:isinsv 129:itilde 456:iukcy ef:iuml
135:jcirc 439:jcy 1d527:jfr 237:jmath 1d55b:jopf 1d4bf:jscr 458:jsercy 454:jukcy 3ba:kappa 3f0:kappav:varkappa
137:kcedil 43a:kcy 1d528:kfr 138:kgreen 445:khcy 45c:kjcy 1d55c:kopf 1d4c0:kscr 291b:lAtail 290e:lBarr
2a8b:lEg:lesseqqgtr 2962:lHar 13a:lacute 29b4:laemptyv 3bb:lambda 2991:langd 2a85:lap:lessapprox ab:laquo
291f:larrbfs 291d:larrfs 21ab:larrlp:looparrowleft 2939:larrpl 2973:larrsim 21a2:larrtl:leftarrowtail 2aab:lat
2919:latail 2aad:late 2aad,fe00:lates 290c:lbarr 2772:lbbrk 7b:lbrace:lcub 5b:lbrack:lsqb 298b:lbrke
298f:lbrksld 298d:lbrkslu 13e:lcaron 13c:lcedil 43b:lcy 2936:ldca 2967:ldrdhar 294b:ldrushar 21b2:ldsh
2264:le:leq 21c7:leftleftarrows:llarr 22cb:leftthreetimes:lthree 2aa8:lescc 2a7f:lesdot 2a81:lesdoto
2a83:lesdotor 22da,fe00:lesg 2a93:lesges 22d6:lessdot:ltdot 297c:lfisht 1d529:lfr 2a91:lgE 296a:lharul
2584:lhblk 459:ljcy 296b:llhard 25fa:lltri 140:lmidot 23b0:lmoust:lmoustache 2268:lnE:lneqq 2a89:lnap:lnapprox
2a87:lne:lneq 22e6:lnsim 27ec:loang 21fd:loarr 27fc:longmapsto:xmap 21ac:looparrowright:rarrlp 2985:lopar
1d55d:lopf 2a2d:loplus 2a34:lotimes 2217:lowast 25ca:loz:lozenge 28:lpar 2993:lparlt 296d:lrhard 200e:lrm
22bf:lrtri 2039:lsaquo 1d4c1:lscr 2a8d:lsime 2a8f:lsimg 201a:lsquor:sbquo 142:lstrok 2aa6:ltcc 2a79:ltcir
22c9:ltimes 2976:ltlarr 2a7b:ltquest 2996:ltrPar 25c3:ltri:triangleleft 294a:lurdshar 2966:luruhar
2268,fe00:lvertneqq:lvnE 223a:mDDot af:macr:strns 2642:male 2720:malt:maltese 25ae:marker 2a29:mcomma 43c:mcy
2014:mdash 1d52a:mfr 2127:mho b5:micro 2af0:midcir 2212:minus 2a2a:minusdu 2adb:mlcp 22a7:models 1d55e:mopf
1d4c2:mscr 3bc:mu 22b8:multimap:mumap 22d9,338:nGg 226b,20d2:nGt 21cd:nLeftarrow:nlArr
21ce:nLeftrightarrow:nhArr 22d8,338:nLl 226a,20d2:nLt 21cf:nRightarrow:nrArr 22af:nVDash 22ae:nVdash 144:nacute
2220,20d2:nang 2a70,338:napE 224b,338:napid 149:napos 266e:natur:natural 2a43:ncap 148:ncaron 146:ncedil
2a6d,338:ncongdot 2a42:ncup 43d:ncy 2013:ndash 21d7:neArr 2924:nearhk 2250,338:nedot 2928:nesear:toea 1d52b:nfr
21ae:nharr:nleftrightarrow 2af2:nhpar 22fc:nis 22fa:nisd 45a:njcy 2266,338:nlE:nleqq 219a:nlarr:nleftarrow
2025:nldr 1d55f:nopf ac:not 22f9,338:notinE 22f5,338:notindot 22f7:notinvb 22f6:notinvc 22fe:notnivb
22fd:notnivc 2afd,20e5:nparsl 2202,338:npart 2a14:npolint 219b:nrarr:nrightarrow 2933,338:nrarrc 219d,338:nrarrw
1d4c3:nscr 2284:nsub 2ac5,338:nsubE:nsubseteqq 2285:nsup 2ac6,338:nsupE:nsupseteqq f1:ntilde 3bd:nu 23:num
2116:numero 2007:numsp 22ad:nvDash 2904:nvHarr 224d,20d2:nvap 22ac:nvdash 2265,20d2:nvge 3e,20d2:nvgt
29de:nvinfin 2902:nvlArr 2264,20d2:nvle 3c,20d2:nvlt 22b4,20d2:nvltrie 2903:nvrArr 22b5,20d2:nvrtrie
223c,20d2:nvsim 21d6:nwArr 2923:nwarhk 2927:nwnear f3:oacute f4:ocirc 43e:ocy 151:odblac 2a38:odiv 29bc:odsold
153:oelig 29bf:ofcir 1d52c:ofr 2db:ogon f2:ograve 29c1:ogt 29b5:ohbar 29be:olcir 29bb:olcross 29c0:olt 14d:omacr
3c9:omega 3bf:omicron 29b6:omid 1d560:oopf 29b7:opar 29b9:operp 2228:or:vee 2a5d:ord 2134:order:orderof:oscr
aa:ordf ba:ordm 22b6:origof 2a56:oror 2a57:orslope 2a5b:orv f8:oslash 2298:osol f5:otilde 2a36:otimesas f6:ouml
233d:ovbar b6:para 2af3:parsim 2afd:parsl 43f:pcy 25:percnt 2e:period 2030:permil 2031:pertenk 1d52d:pfr 3c6:phi
3d5:phiv:straightphi:varphi 260e:phone 3c0:pi 3d6:piv:varpi 210e:planckh 2b:plus 2a23:plusacir 2a22:pluscir
2a25:plusdu 2a72:pluse 2a26:plussim 2a27:plustwo 2a15:pointint 1d561:popf a3:pound 2ab3:prE 2ab7:prap:precapprox
2ab9:precnapprox:prnap 2ab5:precneqq:prnE 22e8:precnsim:prnsim 2032:prime 232e:profalar 2312:profline
2313:profsurf 22b0:prurel 1d4c5:pscr 3c8:psi 2008:puncsp 1d52e:qfr 1d562:qopf 2057:qprime 1d4c6:qscr
2a16:quatint 3f:quest 291c:rAtail 2964:rHar 223d,331:race 155:racute 29b3:raemptyv 2992:rangd 29a5:range
bb:raquo 2975:rarrap 2920:rarrbfs 2933:rarrc 291e:rarrfs 2945:rarrpl 2974:rarrsim 21a3:rarrtl:rightarrowtail
219d:rarrw:rightsquigarrow 291a:ratail 2236:ratio 2773:rbbrk 7d:rbrace:rcub 5d:rbrack:rsqb 298c:rbrke
298e:rbrksld 2990:rbrkslu 159:rcaron 157:rcedil 440:rcy 2937:rdca 2969:rdldhar 21b3:rdsh 25ad:rect 297d:rfisht
1d52f:rfr 296c:rharul 3c1:rho 3f1:rhov:varrho 21c9:rightrightarrows:rrarr 22cc:rightthreetimes:rthree 2da:ring
200f:rlm 23b1:rmoust:rmoustache 2aee:rnmid 27ed:roang 21fe:roarr 2986:ropar 1d563:ropf 2a2e:roplus 2a35:rotimes
29:rpar 2994:rpargt 2a12:rppolint 203a:rsaquo 1d4c7:rscr 22ca:rtimes 25b9:rtri:triangleright 29ce:rtriltri
2968:ruluhar 211e:rx 15b:sacute 2ab4:scE 2ab8:scap:succapprox 161:scaron 15f:scedil 15d:scirc 2ab6:scnE:succneqq
2aba:scnap:succnapprox 22e9:scnsim:succnsim 2a13:scpolint 441:scy 22c5:sdot 2a66:sdote 21d8:seArr a7:sect
3b:semi 2929:seswar:tosa 2736:sext 1d530:sfr 266f:sharp 449:shchcy 448:shcy ad:shy 3c3:sigma
3c2:sigmaf:sigmav:varsigma 2a6a:simdot 2a9e:simg 2aa0:simgE 2a9d:siml 2a9f:simlE 2246:simne 2a24:simplus
2972:simrarr 2a33:smashp 29e4:smeparsl 2323:smile:ssmile 2aaa:smt 2aac:smte 2aac,fe00:smtes 44c:softcy 2f:sol
29c4:solb 233f:solbar 1d564:sopf 2660:spades:spadesuit 2293,fe00:sqcaps 2294,fe00:sqcups 1d4c8:sscr 2606:star
2282:sub:subset 2ac5:subE:subseteqq 2abd:subdot 2ac3:subedot 2ac1:submult 2acb:subnE:subsetneqq
228a:subne:subsetneq 2abf:subplus 2979:subrarr 2ac7:subsim 2ad5:subsub 2ad3:subsup 266a:sung b9:sup1 b2:sup2
b3:sup3 2ac6:supE:supseteqq 2abe:supdot 2ad8:supdsub 2ac4:supedot 27c9:suphsol 2ad7:suphsub 297b:suplarr
2ac2:supmult 2acc:supnE:supsetneqq 228b:supne:supsetneq 2ac0:supplus 2ac8:supsim 2ad4:supsub 2ad6:supsup
21d9:swArr 292a:swnwar df:szlig 2316:target 3c4:tau 165:tcaron 163:tcedil 442:tcy 2315:telrec 1d531:tfr
3b8:theta 3d1:thetasym:thetav:vartheta fe:thorn d7:times 2a31:timesbar 2a30:timesd 2336:topbot 2af1:topcir
1d565:topf 2ada:topfork 2034:tprime 25b5:triangle:utri 225c:triangleq:trie 25ec:tridot 2a3a:triminus
2a39:triplus 29cd:trisb 2a3b:tritime 23e2:trpezium 1d4c9:tscr 446:tscy 45b:tshcy 167:tstrok 2963:uHar fa:uacute
45e:ubrcy 16d:ubreve fb:ucirc 443:ucy 171:udblac 297e:ufisht 1d532:ufr f9:ugrave 2580:uhblk 231c:ulcorn:ulcorner
230f:ulcrop 25f8:ultri 16b:umacr 173:uogon 1d566:uopf 3c5:upsi:upsilon 21c8:upuparrows:uuarr
231d:urcorn:urcorner 230e:urcrop 16f:uring 25f9:urtri 1d4ca:uscr 22f0:utdot 169:utilde fc:uuml 29a7:uwangle
2ae8:vBar 2ae9:vBarv 299c:vangrt 228a,fe00:varsubsetneq:vsubne 2acb,fe00:varsubsetneqq:vsubnE
228b,fe00:varsupsetneq:vsupne 2acc,fe00:varsupsetneqq:vsupnE 432:vcy 22bb:veebar 225a:veeeq 22ee:vellip
1d533:vfr 1d567:vopf 1d4cb:vscr 299a:vzigzag 175:wcirc 2a5f:wedbar 2259:wedgeq 2118:weierp:wp 1d534:wfr
1d568:wopf 1d4cc:wscr 1d535:xfr 3be:xi 22fb:xnis 1d569:xopf 1d4cd:xscr fd:yacute 44f:yacy 177:ycirc 44b:ycy
a5:yen 1d536:yfr 457:yicy 1d56a:yopf 1d4ce:yscr 44e:yucy ff:yuml 17a:zacute 17e:zcaron 437:zcy 17c:zdot 3b6:zeta
1d537:zfr 436:zhcy 21dd:zigrarr 1d56b:zopf 1d4cf:zscr 200d:zwj 200c:zwnj`.split(/\s+/)) {
  const [points,...names]=record.split(':');
  const value=String.fromCodePoint(...points.split(',').map(s=>Number.parseInt(s,16)));
  for (const name of names) htmlEntities.set(name,value);
}
const legacyEntityNames=new Set(`AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc Igrave
Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute
acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc
egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp
not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2
sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml`.split(/\s+/));
function htmlValue(text) {
  return text.replace(/&(#(?:x[0-9a-f]+|\d+);|([a-z][a-z0-9]*)(;?))/gi,(all,entity,name,semicolon,offset)=>{
    if (name) {
      if (!semicolon && (!legacyEntityNames.has(name) || /[=a-z0-9]/i.test(text[offset+all.length] ?? ''))) return all;
      return htmlEntities.get(name) ?? all;
    }
    const hex=entity[1].toLowerCase()==='x', code=Number.parseInt(entity.slice(hex?2:1,-1),hex?16:10);
    return code>0 && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
  });
}

function location(name, checkFile = true) {
  const abs=path.resolve(name), root=path.parse(abs).root, parts=abs.slice(root.length).split(path.sep).filter(Boolean);
  if (!parts.length) refuse('需要文件路径');
  let cursor=root, stat, parent;
  for (const [i,part] of parts.entries()) {
    cursor=path.join(cursor,part);
    stat=fs.lstatSync(cursor,{bigint:true,throwIfNoEntry:false});
    if (i===parts.length-1) break;
    if (!stat?.isDirectory() || stat.isSymbolicLink() || path.relative(cursor,fs.realpathSync.native(cursor)))
      refuse('文件夹身份未核：'+cursor);
    parent=stat;
  }
  if (checkFile && stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1n || path.relative(abs,fs.realpathSync.native(abs))))
    refuse('拒绝读取或替换非普通文件、路径别名或链接：'+abs);
  return {abs,stat,parent:parent ?? fs.lstatSync(root,{bigint:true})};
}
const same=(a,b)=>!!a && !!b && a.dev===b.dev && a.ino===b.ino;
const unchanged=(a,b)=>same(a,b) && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs && b.nlink===1n;
function bytesAt(file,max,prefixOnly=false) {
  if (!file.stat) refuse('找不到文件：'+file.abs);
  if (!prefixOnly && file.stat.size>BigInt(max)) refuse('文件超过读取上限：'+file.abs);
  const fd=fs.openSync(file.abs,'r');
  try {
    if (!unchanged(file.stat,fs.fstatSync(fd,{bigint:true})) || !unchanged(file.stat,location(file.abs).stat))
      refuse('读取前文件已变动');
    const bytes=Buffer.alloc(Math.min(max,Number(file.stat.size)));
    let got=0;
    while (got<bytes.length) {
      const n=fs.readSync(fd,bytes,got,bytes.length-got,got);
      if (!n) refuse('读取时文件已变动');
      got+=n;
    }
    if (!unchanged(file.stat,fs.fstatSync(fd,{bigint:true})) || !unchanged(file.stat,location(file.abs).stat))
      refuse('读取时文件已变动');
    return bytes;
  } finally { fs.closeSync(fd); }
}

function generatorMarker(raw) {
  const {matches}=headMeta(raw.subarray(0,MAX_HEAD).toString('utf8'),'coach-generator');
  return matches.some(m=>/^eli5-report(?:\/|$)/.test(m.value)) ? matches : null;
}
function checkPage(raw) {
  const matches=generatorMarker(raw);
  if (!matches) return false;
  const html=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw);
  if (matches.length!==1 || !matches[0].valid || matches[0].value!==GENERATOR) refuse('生成器标记残缺、重复或版本未知');
  const at=html.indexOf(DATA_TAG), end=html.indexOf('</script>',at+DATA_TAG.length);
  if (at<0 || end<0) refuse('没有完整的业务数据');
  const data=normalize(parseJson(html.slice(at+DATA_TAG.length,end)));
  if (!Buffer.from(render(data)).equals(raw)) refuse('批次、图、按钮或数据与原生成页不同');
  return true;
}

function replacePage(input, output, raw, page) {
  if (!path.relative(input.abs,output.abs) || same(input.stat,output.stat)) refuse('输入与输出不能是同一文件');
  const hold=output.abs+'.eli5.lock', temp=output.abs+'.'+process.pid+'.tmp', owned=[];
  const parentOk=()=>same(output.parent,location(output.abs,false).parent);
  function create(abs,bytes) {
    if (!parentOk()) refuse('输出父目录已变动');
    const fd=fs.openSync(abs,'wx');
    try { owned.push([abs,fs.fstatSync(fd,{bigint:true})]); fs.writeFileSync(fd,bytes); }
    finally { fs.closeSync(fd); }
  }
  function holds(abs,stat) {
    return parentOk() && same(stat,fs.lstatSync(abs,{bigint:true,throwIfNoEntry:false}));
  }
  try {
    create(hold,Buffer.alloc(0));
    const current=location(output.abs);
    if (output.stat ? !unchanged(output.stat,current.stat) : !!current.stat) refuse('输出在生成前已变动');
    const old=output.stat?bytesAt(output,MAX_HTML):null;
    if (old && !checkPage(old)) refuse('同名是手写或其它网页，请另存');
    if (old?.equals(page)) return;
    create(temp,page);
    if (!bytesAt(location(temp),MAX_HTML).equals(page) || !bytesAt(input,MAX_JSON).equals(raw))
      refuse('写入前数据或暂存文件已变动');
    const latest=location(output.abs);
    if (!holds(hold,owned[0][1]) || !holds(temp,owned[1][1]) ||
        (output.stat ? !unchanged(output.stat,latest.stat) : !!latest.stat)) refuse('输出在提交前已变动');
    if (output.stat) fs.renameSync(temp,output.abs);
    else fs.linkSync(temp,output.abs);
  } finally {
    for (const [file,stat] of owned.reverse()) {
      try { if (holds(file,stat)) fs.unlinkSync(file); } catch { /* 身份无法复核时不清理他人的文件。 */ }
    }
  }
}

const args=process.argv.slice(2);
const checking=args[0]==='--check';
try {
  if (args.length!==2 || (!checking && args[0].startsWith('--')))
    refuse('用法：eli5-report.mjs <当批.json> <业务.html>，或 --check <业务.html>');
  if (checking) {
    const file=location(args[1]);
    const belongs=generatorMarker(bytesAt(file,MAX_HEAD,true)) && checkPage(bytesAt(file,MAX_HTML));
    console.log(belongs?'通过：ELI5 业务网页':'跳过：非本生成器网页');
  } else {
    const input=location(args[0]), output=location(args[1]), raw=bytesAt(input,MAX_JSON);
    const page=Buffer.from(render(normalize(parseJson(new TextDecoder('utf-8',{fatal:true}).decode(raw)))));
    replacePage(input,output,raw,page);
    console.log('已生成 ELI5 业务网页：'+output.abs);
  }
} catch (error) {
  console.log(checking?'未通过：ELI5 业务网页':'未生成：ELI5 业务网页');
  console.error(error.code ?? error.message);
  process.exitCode=1;
}
