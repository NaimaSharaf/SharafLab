// Slide Notes (Sharaf Lab website version of the Slide Notes Chrome extension).
// Turns a PDF of slides into pictures with a notes box under each one.
// Notes are kept either in a folder on your computer (Chrome / Edge) or inside this browser (any browser).
// You can insert your own slides (text or picture) anywhere, edit them, reorder and remove slides.
// Folder layout:  <folder>/<presentation>/{slides.pdf, presentation.json, notes.md, thumbs/, images/}
import * as pdfjs from './lib/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc=new URL('./lib/pdf.worker.min.mjs',import.meta.url).href;
const FONTS=new URL('./lib/standard_fonts/',import.meta.url).href;
const $=id=>document.getElementById(id);
const tell=(t,cls)=>{const s=$('status');s.textContent=t||'';s.className='status'+(cls?' '+cls:'')};
const THUMB_W=640;
let root=null,deck=null,saveTimer=0,urls=[],zoomAt=-1,addAt=0,offline=false;
const uid=()=>Math.random().toString(36).slice(2,10);
const pad=n=>String(n).padStart(3,'0');

/* ---------- local store: remembered folder + a copy of the last presentation (so it opens instantly) ---------- */
const dbp=new Promise(res=>{const r=indexedDB.open('slide-notes',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>res(r.result);r.onerror=()=>res(null)});
async function kv(k,v){const db=await dbp;if(!db)return;return new Promise(res=>{try{const tx=db.transaction('kv',v===undefined?'readonly':'readwrite'),s=tx.objectStore('kv'),q=v===undefined?s.get(k):s.put(v,k);q.onsuccess=()=>res(q.result);q.onerror=()=>res()}catch{res()}})}
let cacheTimer=0;
function cacheDeck(){clearTimeout(cacheTimer);cacheTimer=setTimeout(async()=>{if(!deck)return;await kv('cache',{name:deck.name,data:deck.data,pics:deck.pics,pending:!!deck.pending})},300)}

/* ---------- "keep notes in this browser": a small folder stored in IndexedDB ----------
   It answers the same calls as a real folder (getDirectoryHandle, getFileHandle, entries, createWritable),
   so the rest of the tool works the same either way. */
const fdbp=new Promise(res=>{const r=indexedDB.open('slide-notes-files',1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>res(r.result);r.onerror=()=>res(null)});
async function fsOp(fn){const db=await fdbp;if(!db)throw new Error('This browser cannot store files.');return new Promise((res,rej)=>{const tx=db.transaction('files',fn.length>1?'readwrite':'readonly'),st=tx.objectStore('files');let out;try{out=fn(st,true)}catch(e){rej(e)}tx.oncomplete=()=>res(out&&out.result!==undefined?out.result:out);tx.onerror=()=>rej(tx.error)})}
const fsGet=p=>fsOp(st=>st.get(p)),fsPut=(p,v)=>fsOp((st,w)=>st.put(v,p)),fsKeys=()=>fsOp(st=>st.getAllKeys());
const notFound=()=>{const e=new Error('Not found');e.name='NotFoundError';return e};
function vdir(path,name){return{kind:'directory',name:name||path.split('/').pop()||'This browser',path,isLocal:true,
  async queryPermission(){return'granted'},async requestPermission(){return'granted'},
  async*entries(){const pre=path?path+'/':'',seen=new Map();for(const k of await fsKeys()){if(!k.startsWith(pre))continue;const rest=k.slice(pre.length),i=rest.indexOf('/');if(!rest)continue;
    if(i<0){const rec=await fsGet(k);if(!seen.has(rest))seen.set(rest,rec&&rec.dir?vdir(k):vfile(k))}else{const n=rest.slice(0,i);if(!seen.has(n)||seen.get(n).kind==='file')seen.set(n,vdir(pre+n))}}
    for(const e of seen)yield e},
  async getDirectoryHandle(n,o={}){const p=(path?path+'/':'')+n,keys=await fsKeys();if(keys.some(k=>k===p||k.startsWith(p+'/')))return vdir(p);if(o.create){await fsPut(p,{dir:true});return vdir(p)}throw notFound()},
  async getFileHandle(n,o={}){const p=(path?path+'/':'')+n,rec=await fsGet(p);if(rec&&!rec.dir)return vfile(p);if(o.create){await fsPut(p,{blob:new Blob([])});return vfile(p)}throw notFound()}}}
function vfile(path){const name=path.split('/').pop();return{kind:'file',name,
  async getFile(){const rec=await fsGet(path);if(!rec||rec.dir)throw notFound();return new File([rec.blob],name,{type:rec.blob.type||(name.endsWith('.png')?'image/png':name.endsWith('.pdf')?'application/pdf':'')})},
  async createWritable(){const parts=[];return{write:async d=>{parts.push(d)},close:async()=>{await fsPut(path,{blob:new Blob(parts,{type:parts[0]&&parts[0].type||''})})},abort:async()=>{}}}}}
const LOCAL='in-browser';

/* ---------- folder ---------- */
async function connect(h,ask){
  if(!h)return false;
  if(h===LOCAL)h=vdir('','This browser');
  let p=await h.queryPermission({mode:'readwrite'});
  if(p!=='granted'){if(!ask)return false;p=await h.requestPermission({mode:'readwrite'});if(p!=='granted'){tell('Folder access was not allowed.','err');return false}}
  root=h;offline=false;await kv('root',h.isLocal?LOCAL:h);$('reconnect').hidden=true;$('reconnectBar').hidden=true;
  $('where').textContent=h.isLocal?'Notes are kept in this browser':'Folder: '+h.name;$('deckRow').hidden=false;
  $('folder').textContent=h.isLocal?'Use a folder instead':'Change folder';$('folder').classList.remove('primary');$('local').classList.remove('primary');$('local').hidden=!!h.isLocal;
  // edits made before the folder was reconnected are written now
  if(deck&&deck.pending){try{deck.dir=await root.getDirectoryHandle(deck.name,{create:true});await writePics(deck);await save(true)}catch(e){tell('Could not save earlier edits: '+e.message,'err')}}
  await listDecks(deck?deck.name:await kv('last'),!!deck);return true;
}
$('folder').onclick=async()=>{if(!('showDirectoryPicker' in window)){tell('Saving to a folder needs Chrome or Edge. Use “Keep notes in this browser” instead.','err');return}
  try{const h=await showDirectoryPicker({mode:'readwrite',id:'slide-notes'});await flush();deck=null;await connect(h,true)}catch(e){if(e.name!=='AbortError')tell(e.message,'err')}};
$('local').onclick=async()=>{await flush();deck=null;await connect(LOCAL,true)};
if(!('showDirectoryPicker' in window)){$('folder').hidden=true;$('local').textContent='Start: keep notes in this browser'}
const reconnect=async()=>{try{await connect(await kv('root'),true)}catch(e){tell(e.message,'err')}};
$('reconnect').onclick=reconnect;$('reconnectBar').onclick=reconnect;

/* ---------- files ---------- */
async function write(dir,name,data){const h=await dir.getFileHandle(name,{create:true}),w=await h.createWritable();try{await w.write(data);await w.close()}catch(e){await w.abort().catch(()=>{});throw e}}
async function readJSON(dir,name){return JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text())}
async function exists(dir,name,kind){try{kind==='dir'?await dir.getDirectoryHandle(name):await dir.getFileHandle(name);return true}catch{return false}}
async function getFile(dir,path){const parts=path.split('/');let d=dir;for(const p of parts.slice(0,-1))d=await d.getDirectoryHandle(p);return (await d.getFileHandle(parts.at(-1))).getFile()}

/* ---------- presentations ---------- */
async function listDecks(select,keepOpen){
  const list=[];
  for await(const [name,h] of root.entries()){if(h.kind!=='directory')continue;try{const d=await readJSON(h,'presentation.json');list.push({name,title:d.title||name,updated:d.updated||''})}catch{}}
  list.sort((a,b)=>String(b.updated).localeCompare(String(a.updated)));
  const sel=$('deck');sel.replaceChildren();
  if(!list.length){sel.add(new Option('No presentations yet — click Add PDF',''));sel.disabled=true;if(!keepOpen)showDeck(false);return}
  sel.disabled=false;for(const d of list)sel.add(new Option(d.title,d.name));
  const pick=list.some(d=>d.name===select)?select:list[0].name;sel.value=pick;
  if(keepOpen&&deck&&deck.name===pick){deck.dir=await root.getDirectoryHandle(pick);return}
  await openDeck(pick);
}
$('deck').onchange=async()=>{await flush();await openDeck($('deck').value)};

/* ---------- PDF → pictures ---------- */
async function loadPdf(data){return pdfjs.getDocument({data,isEvalSupported:false,standardFontDataUrl:FONTS}).promise}
async function renderThumbs(pdf,dir,only){
  const thumbs=await dir.getDirectoryHandle('thumbs',{create:true});let aspect=4/3;
  for(let i=1;i<=pdf.numPages;i++){
    if(only&&!only.has(i))continue;tell(`Making slide pictures… ${i} of ${pdf.numPages}`);
    const page=await pdf.getPage(i),v1=page.getViewport({scale:1}),v=page.getViewport({scale:THUMB_W/v1.width});if(i===1)aspect=v1.width/v1.height;
    const c=document.createElement('canvas');c.width=Math.round(v.width);c.height=Math.round(v.height);const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);
    await page.render({canvasContext:ctx,viewport:v}).promise;await write(thumbs,pad(i)+'.png',await new Promise(r=>c.toBlob(r,'image/png')));page.cleanup();
  }
  return aspect;
}
$('pdf').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  if(!root){tell('Choose a notes folder first.','err');return}
  await flush();
  try{
    tell('Reading '+file.name+'…');
    const buf=await file.arrayBuffer(),pdf=await loadPdf(buf.slice(0));
    let base=file.name.replace(/\.pdf$/i,'').replace(/[\\/:*?"<>|]/g,'_').trim()||'Presentation',name=base;
    for(let k=2;await exists(root,name,'dir');k++)name=`${base} (${k})`;
    const dir=await root.getDirectoryHandle(name,{create:true});await write(dir,'slides.pdf',file);
    const aspect=await renderThumbs(pdf,dir),now=new Date().toISOString();
    const data={version:2,title:base,pdf:'slides.pdf',source:file.name,pages:pdf.numPages,aspect,created:now,updated:now,general:'',slides:Array.from({length:pdf.numPages},(_,i)=>({id:'p'+(i+1),kind:'pdf',page:i+1,note:''}))};
    await write(dir,'presentation.json',JSON.stringify(data,null,2));await write(dir,'notes.md',markdown(data));
    pdf.destroy();await listDecks(name);tell(`Added ${file.name}: ${data.pages} slide${data.pages>1?'s':''}. Type notes under each slide, or use “+ Add slide” to insert your own.`,'saved');
  }catch(err){tell('Could not open that PDF: '+err.message,'err')}
};

/* ---------- open / show ---------- */
function showDeck(on){$('main').hidden=!on;$('empty').hidden=!!on}
function migrate(d){
  if(!d.slides){d.slides=Array.from({length:d.pages||0},(_,i)=>({id:'p'+(i+1),kind:'pdf',page:i+1,note:d.notes&&d.notes[i]||''}));delete d.notes;d.version=2}
  d.general=d.general||'';for(const s of d.slides){s.note=s.note||'';if(!s.id)s.id=uid()}return d;
}
async function openDeck(name){
  if(!name){deck=null;showDeck(false);return}
  const dir=await root.getDirectoryHandle(name),data=migrate(await readJSON(dir,'presentation.json'));
  // missing pictures (e.g. the folder was copied without thumbs/)? make them again from the PDF
  const thumbs=await dir.getDirectoryHandle('thumbs',{create:true}),missing=new Set();
  for(const s of data.slides)if(s.kind==='pdf'&&!await exists(thumbs,pad(s.page)+'.png'))missing.add(s.page);
  if(missing.size&&await exists(dir,data.pdf||'slides.pdf')){try{const pdf=await loadPdf(await (await getFile(dir,data.pdf||'slides.pdf')).arrayBuffer());await renderThumbs(pdf,dir,missing);pdf.destroy();tell('')}catch(e){tell('Some slide pictures could not be made: '+e.message,'err')}}
  const pics={};
  for(const s of data.slides){try{if(s.kind==='pdf')pics[s.id]=await getFile(dir,'thumbs/'+pad(s.page)+'.png');else if(s.kind==='image')pics[s.id]=await getFile(dir,s.file)}catch{}}
  deck={name,dir,data,pics,pending:false};await kv('last',name);render();cacheDeck();
}
function render(){
  for(const u of urls)URL.revokeObjectURL(u);urls=[];
  const d=deck.data;showDeck(true);
  $('title').value=d.title;$('general').value=d.general;autosize($('general'));
  const nPdf=d.slides.filter(s=>s.kind==='pdf').length,nOwn=d.slides.length-nPdf;
  $('meta').textContent=`${d.slides.length} slide${d.slides.length!==1?'s':''}${nOwn?` (${nOwn} added by you)`:''} · ${d.source||'slides.pdf'} · added ${new Date(d.created).toLocaleDateString()}`;
  $('sn').style.setProperty('--ar',String(d.aspect||4/3));
  const ol=$('slides');ol.replaceChildren();
  ol.append(adder(0));
  d.slides.forEach((s,i)=>{ol.append(card(s,i));ol.append(adder(i+1))});
  filter();
}
function adder(at){const li=document.createElement('li');li.className='adder';li.innerHTML='<button title="Insert a slide here">+ Add slide</button>';li.querySelector('button').onclick=e=>openAddMenu(at,e.currentTarget);return li}
function card(s,i){
  const li=document.createElement('li');li.className='slide';li.dataset.i=i;li.dataset.id=s.id;
  const tag=s.kind==='pdf'?`PDF page ${s.page}`:s.kind==='text'?'your text slide':'your picture';
  li.innerHTML=`<div class="head"><span><b>Slide ${i+1}</b><span class="tag">${tag}</span></span><span class="acts"><span class="small wc"></span><button data-a="up" title="Move up">↑</button><button data-a="down" title="Move down">↓</button><button data-a="del" title="Remove this slide">✕</button></span></div><div class="vis"></div><textarea class="note" placeholder="Notes for slide ${i+1}…" aria-label="Notes for slide ${i+1}"></textarea>`;
  const vis=li.querySelector('.vis');
  if(s.kind==='text'){
    vis.innerHTML=`<div class="tslide"><div class="t" contenteditable="true" spellcheck="true"></div><div class="b" contenteditable="true" spellcheck="true"></div><input type="color" class="bg" title="Background color"></div>`;
    const box=vis.querySelector('.tslide'),t=box.querySelector('.t'),b=box.querySelector('.b'),bg=box.querySelector('.bg');
    t.textContent=s.title||'';b.textContent=s.body||'';bg.value=s.bg||'#ffffff';paintText(box,s);
    t.oninput=()=>{s.title=t.innerText.replace(/\n+$/,'');changed()};b.oninput=()=>{s.body=b.innerText.replace(/\n+$/,'');changed()};
    t.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();b.focus()}};
    bg.oninput=()=>{s.bg=bg.value;paintText(box,s);changed()};
    box.ondblclick=e=>{if(e.target===box)openZoom(i)};
  }else{
    const img=document.createElement('img');img.className='thumb';img.alt=`Slide ${i+1}`;const f=deck.pics[s.id];
    if(f){const u=URL.createObjectURL(f);urls.push(u);img.src=u}else img.alt+=' (picture missing)';
    img.onclick=()=>openZoom(i);vis.append(img);
    if(s.kind==='image'){const r=document.createElement('button');r.textContent='Replace picture';r.className='small';r.style.marginTop='4px';r.onclick=()=>pickImage(i,true);vis.append(r)}
  }
  const ta=li.querySelector('textarea');ta.value=s.note;ta.oninput=()=>{s.note=ta.value;autosize(ta);wc(li,s);changed()};wc(li,s);requestAnimationFrame(()=>autosize(ta));
  li.querySelector('[data-a=up]').disabled=i===0;li.querySelector('[data-a=down]').disabled=i===deck.data.slides.length-1;
  li.querySelector('[data-a=up]').onclick=()=>move(i,-1);li.querySelector('[data-a=down]').onclick=()=>move(i,1);
  li.querySelector('[data-a=del]').onclick=()=>removeSlide(i);
  return li;
}
function paintText(box,s){const bg=s.bg||'#ffffff',dark=lum(bg)<0.45;box.style.background=bg;box.style.color=dark?'#ffffff':'#1d2433'}
function lum(hex){const n=parseInt(hex.slice(1),16);return (0.299*(n>>16)+0.587*(n>>8&255)+0.114*(n&255))/255}
const wc=(li,s)=>{const t=s.note.trim(),w=t?t.split(/\s+/).length:0;li.querySelector('.wc').textContent=w?w+' word'+(w>1?'s':''):''};
function autosize(ta){ta.style.height='auto';ta.style.height=Math.max(64,ta.scrollHeight+2)+'px'}
$('title').oninput=()=>{if(!deck)return;deck.data.title=$('title').value;const o=[...$('deck').options].find(o=>o.value===deck.name);if(o)o.textContent=deck.data.title||deck.name;changed()};
$('general').oninput=()=>{if(!deck)return;deck.data.general=$('general').value;autosize($('general'));changed()};

/* ---------- add / move / remove slides ---------- */
function openAddMenu(at,btn){addAt=at;const m=$('addMenu'),r=btn.getBoundingClientRect();m.hidden=false;m.style.left=Math.max(8,Math.min(r.left,innerWidth-m.offsetWidth-8))+'px';m.style.top=Math.min(r.bottom+4,innerHeight-m.offsetHeight-8)+'px'}
addEventListener('pointerdown',e=>{if(!$('addMenu').hidden&&!$('addMenu').contains(e.target)&&!e.target.closest('.adder'))$('addMenu').hidden=true});
$('addMenu').onclick=async e=>{const a=e.target.dataset.add;if(!a)return;$('addMenu').hidden=true;
  if(a==='text'){const s={id:uid(),kind:'text',title:'',body:'',bg:'#ffffff',note:''};deck.data.slides.splice(addAt,0,s);render();changed(true);const li=[...$('slides').querySelectorAll('.slide')].find(l=>l.dataset.id===s.id);li.scrollIntoView({block:'center'});li.querySelector('.t').focus()}
  if(a==='image')pickImage(addAt,false);
  if(a==='paste'){try{for(const it of await navigator.clipboard.read()){const ty=it.types.find(t=>t.startsWith('image/'));if(ty){await addPicture(await it.getType(ty),addAt,false);return}}tell('No picture on the clipboard. Copy a picture first.','err')}catch{tell('Clipboard unavailable. Use “Picture (choose a file)” instead.','err')}}
};
let imgTarget=null;
function pickImage(i,replace){imgTarget={i,replace};$('imgFile').click()}
$('imgFile').onchange=async e=>{const f=e.target.files[0];e.target.value='';if(f&&imgTarget)await addPicture(f,imgTarget.i,imgTarget.replace)};
async function addPicture(blob,i,replace){
  if(!/^image\//.test(blob.type)){tell('Choose a PNG, JPEG, WebP or GIF picture.','err');return}
  const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[blob.type]||'png';
  let s;if(replace){s=deck.data.slides[i]}else{s={id:uid(),kind:'image',note:''};deck.data.slides.splice(i,0,s)}
  s.file='images/'+s.id+'-'+Date.now().toString(36)+'.'+ext;deck.pics[s.id]=blob;deck.newPics=(deck.newPics||[]).concat(s.id);
  render();changed(true);tell(replace?'Picture replaced.':'Picture slide added.','saved');
}
function move(i,dir){const a=deck.data.slides,j=i+dir;if(j<0||j>=a.length)return;[a[i],a[j]]=[a[j],a[i]];render();changed(true);
  const li=$('slides').querySelectorAll('.slide')[j];if(li)li.scrollIntoView({block:'nearest'})}
function removeSlide(i){const s=deck.data.slides[i];const what=s.kind==='pdf'?`PDF page ${s.page}`:'this slide';
  if(!confirm(`Remove slide ${i+1} (${what})${s.note.trim()?' and its notes':''}? ${s.kind==='pdf'?'The PDF itself is not changed.':''}`))return;
  deck.data.slides.splice(i,1);delete deck.pics[s.id];render();changed(true)}

/* ---------- text slide → picture (for notes.md and the enlarged view) ---------- */
function textSlideCanvas(s,W=1280){
  const H=Math.round(W/(deck.data.aspect||4/3)),c=document.createElement('canvas');c.width=W;c.height=H;const x=c.getContext('2d'),bg=s.bg||'#ffffff',fg=lum(bg)<0.45?'#ffffff':'#1d2433';
  x.fillStyle=bg;x.fillRect(0,0,W,H);x.fillStyle=fg;x.textBaseline='top';
  const wrap=(text,font,size,y,maxY)=>{x.font=`${font} ${size}px system-ui,-apple-system,sans-serif`;const L=W*0.86,lh=size*1.3;
    for(const para of String(text||'').split('\n')){let line='';for(const w of para.split(/(\s+)/)){const t=line+w;if(x.measureText(t).width>L&&line.trim()){if(y+lh>maxY)return y;x.fillText(line.trimEnd(),W*0.07,y);y+=lh;line=w.trimStart()}else line=t}
      if(y+lh>maxY)return y;x.fillText(line,W*0.07,y);y+=lh}return y};
  let y=wrap(s.title,'bold',Math.round(W*0.048),H*0.08,H*0.4);wrap(s.body,'',Math.round(W*0.03),y+H*0.04,H*0.94);
  return c;
}

/* ---------- saving ---------- */
function markdown(d){
  const out=[`# ${d.title}`,'',`${d.slides.length} slides · ${d.source||'slides.pdf'}`,''];
  if(d.general.trim())out.push('## Overall notes','',d.general.trim(),'');
  d.slides.forEach((s,i)=>{out.push(`## Slide ${i+1}`+(s.kind==='pdf'?` (PDF page ${s.page})`:''),'');
    const pic=s.kind==='pdf'?`thumbs/${pad(s.page)}.png`:s.kind==='image'?s.file:`thumbs/text-${s.id}.png`;out.push(`![Slide ${i+1}](${pic})`,'');
    if(s.kind==='text'){if(s.title)out.push('**'+s.title+'**','');if(s.body)out.push(s.body,'')}
    if(s.note.trim())out.push('> '+s.note.trim().replace(/\n/g,'\n> '),'')});
  return out.join('\n');
}
function changed(now){if(!deck)return;cacheDeck();if(offline||!root){deck.pending=true;$('reconnectBar').hidden=false;$('reconnectBar').textContent='Saved here for now — click to reconnect your folder and save to it';return}
  tell('Saving…');clearTimeout(saveTimer);saveTimer=setTimeout(save,now?50:600)}
async function writePics(d){for(const id of d.newPics||[]){const s=d.data.slides.find(x=>x.id===id),b=d.pics[id];if(!s||!b)continue;const imgs=await d.dir.getDirectoryHandle('images',{create:true});await write(imgs,s.file.split('/')[1],b)}d.newPics=[]}
async function save(force){
  clearTimeout(saveTimer);saveTimer=0;if(!deck||(!root&&!force))return;const d=deck;
  try{
    await writePics(d);
    const th=await d.dir.getDirectoryHandle('thumbs',{create:true});
    for(const s of d.data.slides)if(s.kind==='text'){const sig=JSON.stringify([s.title,s.body,s.bg]);if(s._drawn!==sig){await write(th,`text-${s.id}.png`,await new Promise(r=>textSlideCanvas(s,THUMB_W).toBlob(r,'image/png')));Object.defineProperty(s,'_drawn',{value:sig,writable:true,enumerable:false})}}
    d.data.updated=new Date().toISOString();await write(d.dir,'presentation.json',JSON.stringify(d.data,null,2));await write(d.dir,'notes.md',markdown(d.data));
    d.pending=false;cacheDeck();tell('Saved '+new Date().toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}),'saved');
  }catch(e){d.pending=true;cacheDeck();offline=true;tell('Not saved to the folder yet ('+e.message+'). Your edits are kept; click the bar to reconnect.','err');$('reconnectBar').hidden=false;$('reconnectBar').textContent='Click to reconnect your folder and save'}
}
async function flush(){if(saveTimer)await save()}
addEventListener('pagehide',()=>{if(saveTimer)save()});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&saveTimer)save()});

/* ---------- search, size, copy ---------- */
function filter(){if(!deck)return;const q=$('search').value.trim().toLowerCase();for(const li of $('slides').querySelectorAll('.slide')){const s=deck.data.slides[+li.dataset.i],t=[s.note,s.title,s.body].join(' ').toLowerCase(),hit=!q||t.includes(q)||String(+li.dataset.i+1)===q;li.classList.toggle('miss',!hit);li.classList.toggle('hit',!!q&&hit)}
  for(const a of $('slides').querySelectorAll('.adder'))a.hidden=!!q}
$('search').oninput=filter;
const setSize=v=>{const box=$('sn');box.classList.remove('s','m','l');box.classList.add(v);$('size').value=v;try{localStorage.slideSize=v}catch{}};
$('size').onchange=()=>setSize($('size').value);try{setSize(localStorage.slideSize||'m')}catch{setSize('m')}
$('copyAll').onclick=async()=>{if(!deck)return;const d=deck.data,lines=[d.title,''];if(d.general.trim())lines.push('Overall notes:',d.general.trim(),'');
  d.slides.forEach((s,i)=>{const head=s.kind==='text'&&s.title?` (${s.title})`:'';if(s.note.trim())lines.push(`Slide ${i+1}${head}: ${s.note.trim()}`)});
  try{await navigator.clipboard.writeText(lines.join('\n'));tell('All notes copied.','saved')}catch{tell('Clipboard unavailable.','err')}};

$('dlNotes').onclick=()=>{if(!deck)return;const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([markdown(deck.data)],{type:'text/markdown'}));
  a.download=(deck.data.title||'notes').replace(/[\\/:*?"<>|]/g,'_')+' - notes.md';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),1000);tell('Notes downloaded.','saved')};

/* ---------- enlarge a slide ---------- */
function openZoom(i){zoomAt=i;const s=deck.data.slides[i];let src;
  if(s.kind==='text')src=textSlideCanvas(s).toDataURL('image/png');else{const li=[...$('slides').querySelectorAll('.slide')][i];src=li.querySelector('img').src}
  $('zoomImg').src=src;$('zoomImg').alt='Slide '+(i+1);$('zoomCap').textContent=`Slide ${i+1} of ${deck.data.slides.length}`;$('zoom').hidden=false}
$('zClose').onclick=()=>{$('zoom').hidden=true;const li=[...$('slides').querySelectorAll('.slide')][zoomAt];if(li)li.scrollIntoView({block:'center'})};
$('zPrev').onclick=()=>{if(zoomAt>0)openZoom(zoomAt-1)};$('zNext').onclick=()=>{if(deck&&zoomAt<deck.data.slides.length-1)openZoom(zoomAt+1)};
$('zoom').onclick=e=>{if(e.target===$('zoom'))$('zClose').onclick()};
addEventListener('keydown',e=>{if($('zoom').hidden)return;if(e.key==='Escape')$('zClose').onclick();if(e.key==='ArrowLeft')$('zPrev').onclick();if(e.key==='ArrowRight')$('zNext').onclick()});

/* ---------- start: open the last presentation right away ---------- */
(async()=>{
  showDeck(false);const h=await kv('root');
  if(h&&await connect(h,false).catch(()=>false))return;
  // folder needs a click to allow access again: show the last presentation from the local copy meanwhile
  const c=await kv('cache');
  if(h){$('where').textContent='Folder: '+h.name;$('reconnectBar').hidden=false;$('reconnectBar').textContent=`Click to reconnect “${h.name}” (if Chrome offers “Allow on every visit”, choose it to skip this next time)`}
  if(c&&c.data){offline=true;deck={name:c.name,dir:null,data:migrate(c.data),pics:c.pics||{},pending:!!c.pending,newPics:c.pending?Object.keys(c.pics||{}).filter(id=>(c.data.slides.find(s=>s.id===id)||{}).kind==='image'):[]};render();
    tell(`Opened your last presentation, “${c.data.title}”. You can keep typing; it saves to the folder when you reconnect.`)}
})();
