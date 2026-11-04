// Real Chromium fixture: node check-fold-browser.mjs, then open the printed URL.
// Serves only synthetic DOM and the current plugin source on loopback.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  .replace('      dictionaries,\n      inject,', '      foldCluster,\n      cancelClusterMotion,\n      dictionaries,\n      inject,');
const html = `<!doctype html><html data-chat-sessions-flatten><meta charset="utf-8">
<title>Bottom fold browser regression</title>
<style>
body{margin:0;background:#141820;color:#dbe5ef;font:14px system-ui}h1{font-size:16px;margin:16px 20px}button{margin:4px}#viewport{position:absolute;left:20px;top:80px;width:280px;height:400px;overflow:auto;transform:translateZ(0);background:#202833}#list{font:13px system-ui;color:rgb(180,210,230)}.row{height:34px;box-sizing:border-box;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid #344354}#filler{order:-1!important;background:linear-gradient(#293442,#1e2734)}#tail{order:110!important}pre{margin:440px 20px 0;white-space:pre-wrap}
</style><h1>Synthetic scroll-clamp fixture · current client.js</h1><button id="run">Run four scroll cases</button><button id="reverse">Run bottom reversals</button><div id="viewport"></div><pre id="result">Ready</pre>
<script>window.__ModuleLoader__={load(entry){window.foldApi=entry.factory(id=>id==='react/jsx-runtime'?{jsx(){},jsxs(){}}:{})}};</script>
<script src="/client.js"></script><script>
const api=window.foldApi; const css=document.createElement('style');css.textContent=api.ungroupedCss();document.head.append(css);
const vp=document.querySelector('#viewport');let list, header, rows;
function setup(name){
 if(list)api.cancelClusterMotion(list);
 vp.innerHTML='<div id="list" data-chat-sessions-container><div id="filler"></div><div class="row" data-chat-sessions-cluster-header data-row-key="chat-sessions:cluster-header">独立对话</div><div data-chat-sessions-group><div class="row" data-row-key="session:1">First conversation</div><div class="row" data-row-key="session:2">Second conversation</div><div class="row" data-row-key="session:3">Third conversation</div></div><div id="tail"></div></div>';
 list=vp.firstElementChild;header=list.querySelector('[data-chat-sessions-cluster-header]');rows=[...list.querySelectorAll('[data-row-key^="session:"]')];
 list.querySelector('#filler').style.height=(name==='top'||name==='middle'?100:600)+'px';
 list.querySelector('#tail').style.height=(name==='top'||name==='middle'?600:0)+'px';
 vp.scrollTop=name==='top'?0:name==='middle'?90:vp.scrollHeight-vp.clientHeight-(name==='partial'?50:0);
 return vp.scrollTop;
}
function pause(time){for(const a of document.getAnimations()){a.pause();a.currentTime=time;}void list.offsetHeight;}
function bounds(el){const r=el.getBoundingClientRect();const cp=getComputedStyle(el).clipPath;const values=cp.slice(6,-1).trim().split(/\\s+/).map(parseFloat);const t=values[0]||0;const b=values[2]??t;return {top:r.top+t,bottom:r.bottom-b,opacity:Number(getComputedStyle(el).opacity)};}
function assert(ok,msg){if(!ok)throw Error(msg);}
window.runFoldCases=()=>{
 const results=[];
 for(const name of ['top','middle','partial','full']){
  const scroll=setup(name);const anchor=header.getBoundingClientRect().bottom;api.foldCluster(list,true,true);pause(0);
  const clamp=scroll-vp.scrollTop;const clones=[...document.querySelectorAll('[data-chat-sessions-fold-exits] > *')];
  assert(clones.length===3,name+': exit count');assert(clones[0].parentElement.parentElement===document.body,name+': portal');
  const samples=[];
  for(const time of [0,50,100,150,199]){pause(time);const h=header.getBoundingClientRect().bottom;const b=bounds(clones[0]);
   if(clamp>0)assert(Math.abs(b.top-h)<0.2,name+': top clip/header crossing at '+time+' '+JSON.stringify({b,h}));
   assert(b.bottom+0.2>=Math.max(b.top,h),name+': bottom crosses header before completion at '+time);
   samples.push({time,header:h,clipTop:b.top,clipBottom:b.bottom});
  }
  results.push({name,scroll,clamp,sourceHeader:anchor,sourceViewport:clones[0].parentElement.style.top,samples});
  for(const a of document.getAnimations())a.finish();
  api.cancelClusterMotion(list);
 }
 document.querySelector('#result').textContent=JSON.stringify(results,null,2);return results;
};
window.runBottomReversals=()=>{
 const results=[];
 for(const name of ['partial','full']){
  setup(name);api.foldCluster(list,true,true);pause(75);
  const clone=document.querySelector('[data-chat-sessions-fold-exits] > *');const before=bounds(clone);const oldHeader=header.getBoundingClientRect().bottom;
  api.foldCluster(list,false,true);pause(0);const after=bounds(rows[0]);const newHeader=header.getBoundingClientRect().bottom;
  for(const k of ['top','bottom','opacity'])assert(Math.abs(before[k]-after[k])<0.2,name+': discontinuity '+k+JSON.stringify({before,after}));
  assert(Math.abs(oldHeader-newHeader)<0.2,name+': header discontinuity');
  assert(!document.querySelector('[data-chat-sessions-fold-exits]'),name+': stale overlay');
  results.push({name,before,after,oldHeader,newHeader});
  api.cancelClusterMotion(list);
 }
 document.querySelector('#result').textContent=JSON.stringify(results,null,2);return results;
};
document.querySelector('#run').onclick=window.runFoldCases;document.querySelector('#reverse').onclick=window.runBottomReversals;
</script></html>`;
const server = createServer((req, res) => {
  if (req.url === '/client.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(source); }
  else if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); }
  else { res.writeHead(404); res.end(); }
});
server.listen(0, '127.0.0.1', () => console.log(`Browser fixture: http://127.0.0.1:${server.address().port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
