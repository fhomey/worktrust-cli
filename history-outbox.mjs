/** Local metadata queue. Never reads transcripts, credentials or the network; preserve does not load it. */
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,constants} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
const MAX_RETRY_SECONDS=24*60*60;
const digest=s=>createHash('sha256').update(s).digest('hex');
const scopeOf=target=>digest(target.url+'\0'+(target.token===process.env.WORKTRUST_MCP_TOKEN && /^[a-f0-9]{64}$/.test(process.env.WORKTRUST_HISTORY_SCOPE??'') ? 'device:'+process.env.WORKTRUST_HISTORY_SCOPE : 'token:'+target.token));
const regular=p=>{const s=lstatSync(p);if(s.isSymbolicLink()||!s.isFile())throw Error('HISTORY_QUEUE_UNSAFE');return s;};
function directory(p) {if(!existsSync(p))mkdirSync(p,{mode:0o700});const s=lstatSync(p);if(s.isSymbolicLink()||!s.isDirectory())throw Error('HISTORY_QUEUE_UNSAFE');}
function write(p,value) {
 const temporary=p+'.'+randomBytes(8).toString('hex')+'.tmp';
 const fd=openSync(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);
 try {writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
 try {if(existsSync(p))regular(p);renameSync(temporary,p);}finally{if(existsSync(temporary))unlinkSync(temporary);}
}
/** Serialize local space reservations; never wait in a hook for another process. */
function reservation(root,run) {
 const path=join(root,'.reservation');let fd;
 try {fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);}
 catch(error) {
  if(error.code!=='EEXIST')throw error;
  const lock=read(path),before=regular(path);
  if(!Number.isSafeInteger(lock?.pid)||lock.pid<=0)throw Error('HISTORY_QUEUE_BUSY');
  try{process.kill(lock.pid,0);throw Error('HISTORY_QUEUE_BUSY');}
  catch(error){if(error.code!=='ESRCH')throw Error('HISTORY_QUEUE_BUSY');}
  if(regular(path).ino!==before.ino)throw Error('HISTORY_QUEUE_BUSY');
  unlinkSync(path);return reservation(root,run);
 }
 try{writeFileSync(fd,JSON.stringify({pid:process.pid}));fsyncSync(fd);return run();}
 finally{closeSync(fd);unlinkSync(path);}
}
function read(p) {if(!existsSync(p))return null;if(regular(p).size>4_500_000)throw Error('HISTORY_QUEUE_UNSAFE');return JSON.parse(readFileSync(p,'utf8'));}
export function queuedHistory(target,body,source) {
 const home=join(homedir(),'.worktrust');directory(home);
 const root=join(home,'history-outbox');directory(root);
 // No bearer, endpoint, local path or user content is stored as an identifier.
 const scope=scopeOf(target),id=digest(scope+'\0'+source+'\0'+body);
 const request=join(root,id+'.request.json'),ack=join(root,id+'.ack.json'),state=join(root,id+'.state.json');
 const acknowledged=read(ack);
 // REPLACED (0.10.29): a batch cut into smaller ones is acknowledged by its pieces; the caller follows them.
 if(acknowledged?.id===id)return {id,status:Array.isArray(acknowledged.replacedBy)?'replaced':'acknowledged',replacedBy:Array.isArray(acknowledged.replacedBy)?acknowledged.replacedBy.filter(child=>/^[a-f0-9]{64}$/.test(child)):[],lines:Number.isInteger(acknowledged.lines)?acknowledged.lines:null,confirm(){},close(){},defer(){},oversize(){},replace(){return [];}};
 const current=read(state);
 reservation(root,()=>{
 if(!existsSync(request)) {
  const files=readdirSync(root);let bytes=0,pending=0;
  for(const file of files) {const stat=regular(join(root,file));bytes+=stat.size;if(file.endsWith('.request.json'))pending++;}
  if(files.length>=12000||pending>=512||bytes+Buffer.byteLength(JSON.stringify({id,scope,source,body}))+1024>64*1024*1024)throw Error('HISTORY_QUEUE_FULL');
  write(request,{id,scope,source,body});
 } else if(read(request)?.body!==body)throw Error('HISTORY_QUEUE_CHANGED');
 });
 const status=current?.status==='review'?'review':current?.status==='oversize'?'oversize':Number(current?.retryAt)>Date.now()?'waiting':'pending';
 const done=(value)=>{write(ack,value);if(existsSync(request)){regular(request);unlinkSync(request);}if(existsSync(state)){regular(state);unlinkSync(state);}};
 return {id,status,retryAt:current?.retryAt??null,
  // close (0.10.27): WorkTrust refused the batch for good (its run closed): kept here it would wait forever, so it is let go.
  // `reason` (0.10.29): 'oversize' for a batch that can never fit one call (one line too large, a run already partly received).
  close(reason){done({id,closedAt:new Date().toISOString(),...(reason?{reason}:{})});},
  // `lines` (0.10.29): how many lines the receipt confirmed, so a batch later found replaced by its pieces counts them once.
  confirm(lines){done({id,confirmedAt:new Date().toISOString(),...(Number.isInteger(lines)?{lines}:{})});},
  defer(reason,seconds=0){if(existsSync(ack))return;write(state,{id,status:reason==='review'?'review':'retry',retryAt:Date.now()+Math.max(0,Math.min(MAX_RETRY_SECONDS,seconds))*1000});},
  // TOO LARGE FOR ONE CALL (0.10.29): WorkTrust answered 413. Marked, never retried as it is: the next pass cuts it smaller.
  oversize(){if(existsSync(ack))return;write(state,{id,status:'oversize',retryAt:0});},
  // ITS PIECES (0.10.29): each piece is queued first, then this batch is acknowledged as replaced by them, so a stop between the
  // two leaves both, and the next pass cuts the same pieces again (the cut is a pure function of the lines). Answers their ids.
  replace(pieces){const ids=pieces.map(piece=>queuedHistory(target,piece.body,piece.source).id);done({id,replacedAt:new Date().toISOString(),replacedBy:ids});return ids;},
 };
}
export function historyRefusal(text,response) {
 let rpc;
 try {rpc=JSON.parse(text.trim().startsWith('{')?text:text.split(/\r?\n/).find(s=>s.startsWith('data:'))?.slice(5));}catch{/* Unknown reply stays retryable, never acknowledged. */}
 const review=rpc?.id===1 && (rpc?.error?.data?.outcome==='review' || String(rpc?.error?.message??'').startsWith('history replacement held for review:'));
 const raw=Number(response.headers.get('retry-after'));
 // A staged run WorkTrust closed or refused (0.10.27: another computer's key, seven days without its last batch) is final.
 const closed=rpc?.id===1 && String(rpc?.error?.message??'').startsWith('history run refused:');
 // A 413 (0.10.29) is the batch, not the queue: it is cut smaller, never sent again as it was, and nothing else waits for it.
 return {reason:review?'review':closed?'closed':response.status===413?'oversize':response.status===429?'capacity':'unconfirmed',seconds:Number.isFinite(raw)&&raw>0?Math.min(MAX_RETRY_SECONDS,raw):0};
}

/** Explicit recovery, even after the AI client removed its source files. A changed account/key
 * cannot replay another coupling's pending data. Review is retried only on an explicit request.
 *
 * THE RE-SPLIT (0.10.29). WorkTrust takes at most 2 MB and 1.5 MB of timelines in one history call; CLI 0.10.28 and older queued
 * batches up to 3.5 MB. `cutter` (the hook's own cut; this file never reads a transcript) decides what fits. A batch that does not
 * fit, or that WorkTrust answered 413, is replaced here by its pieces and the pieces are sent in its place, never the same batch
 * again. A batch of a staged run carries the run's fixed count, so a run is cut again WHOLE, under a new run id, while every one
 * of its batches is still on this computer; once WorkTrust holds part of a run, the rest can never complete it, and is let go
 * (`refused`: WorkTrust keeps the earlier lines counting, and `npx worktrust@latest history` measures again). A single line too
 * large for a call is let go the same way. `only` limits a pass to those batches (and their pieces): the send that just queued them.
 */
export async function resumeHistory(target, {send, confirmed, note, retryReview=false, dry=false, limit=Infinity, cutter=null, only=null}) {
 const root=join(homedir(),'.worktrust','history-outbox'),scope=scopeOf(target);
 const totals={received:0,review:0,waiting:0,batches:0,refused:0,held:0,split:0};let paused=null,sent=0;
 if(!existsSync(root))return totals;
 directory(root);
 const files=readdirSync(root);if(files.length>12000)throw Error('HISTORY_QUEUE_FULL');
 const items=new Map();
 const load=(id)=>{
  if(items.has(id))return items.get(id);
  const item=read(join(root,id+'.request.json'));if(item?.scope!==scope){items.set(id,null);return null;}
  if(typeof item.body!=='string'||typeof item.source!=='string'||item.id!==digest(scope+'\0'+item.source+'\0'+item.body)||item.id!==id)throw Error('HISTORY_QUEUE_CHANGED');
  const rpc=JSON.parse(item.body),entries=rpc?.params?.arguments?.entries;
  if(rpc.jsonrpc!=='2.0'||rpc.id!==1||rpc.method!=='tools/call'||rpc.params.name!=='import_history'||!Array.isArray(entries)||!entries.length||entries.length>200)throw Error('HISTORY_QUEUE_CHANGED');
  const run=rpc.params.arguments.run&&typeof rpc.params.arguments.run.id==='string'?rpc.params.arguments.run:null;
  const loaded={id,body:item.body,source:item.source,rpc,entries,run};items.set(id,loaded);return loaded;
 };
 const ids=files.filter(file=>/^[a-f0-9]{64}\.request\.json$/.test(file)).map(file=>file.slice(0,64)).sort();
 for(const id of ids)load(id);
 // A staged run's batches still on this computer, by run id: the run is cut again whole, or not at all.
 const runOf=(runId)=>[...items.values()].filter(item=>item&&item.run?.id===runId).sort((a,b)=>a.run.index-b.run.index);
 const marked=(id)=>read(join(root,id+'.state.json'))?.status==='oversize';
 const whole=(batches)=>batches.length>0&&batches.length===batches[0].run.count&&batches.every((item,index)=>item.run.index===index&&item.run.count===batches[0].run.count);
 const queue=only?[...only]:[...ids],seen=new Set();
 const letGo=(batches)=>{for(const batch of batches){queuedHistory(target,batch.body,batch.source).close('oversize');items.set(batch.id,null);seen.add(batch.id);totals.refused+=batch.entries.length;}return null;};
 // Cut smaller: answers the pieces' ids, or null when the batch (or its run) can never fit and was let go.
 const resplit=(item,queued,tighter)=>{
  if(item.run){
   const batches=runOf(item.run.id);
   if(!whole(batches))return letGo(batches);
   const pieces=cutter.replan(batches.map(batch=>({rpc:batch.rpc,source:batch.source})),tighter?item.entries:null);
   if(!pieces.length)return letGo(batches);
   let children=[];for(const batch of batches){children=queuedHistory(target,batch.body,batch.source).replace(pieces);items.set(batch.id,null);seen.add(batch.id);}
   totals.split+=batches.length;return children;
  }
  const pieces=cutter.split(item.rpc,item.source,tighter?item.entries:null);
  if(pieces.length<2)return letGo([item]);
  totals.split++;items.set(item.id,null);return queued.replace(pieces.map(body=>({body,source:item.source})));
 };
 while(queue.length) {
  const id=queue.shift();if(seen.has(id))continue;seen.add(id);
  const ack=read(join(root,id+'.ack.json'));
  if(ack?.id===id){if(Array.isArray(ack.replacedBy))queue.unshift(...ack.replacedBy.filter(child=>/^[a-f0-9]{64}$/.test(child)));else if(only&&Number.isInteger(ack.lines))totals.held+=ack.lines;continue;}
  const item=load(id);if(!item)continue;
  const queued=queuedHistory(target,item.body,item.source);totals.batches++;
  if(queued.status==='acknowledged')continue;
  if(queued.status==='replaced'){queue.unshift(...queued.replacedBy);continue;}
  // `limit` (0.10.27): the hook sends a few a run by itself; the rest wait, untouched, for the next run.
  if(sent>=limit){totals.waiting+=item.entries.length;continue;}
  if(queued.status==='review'&&!retryReview){totals.review+=item.entries.length;continue;}
  if(cutter){
   const tighter=queued.status==='oversize',runTooLarge=Boolean(item.run)&&runOf(item.run.id).some(batch=>!cutter.fits(batch.entries)||marked(batch.id));
   if(tighter||!cutter.fits(item.entries)||runTooLarge){
    if(dry){totals.waiting+=item.entries.length;continue;}
    const children=resplit(item,queued,tighter);if(children)queue.unshift(...children);continue;
   }
  }
  if(dry){totals.waiting+=item.entries.length;continue;}
  if(queued.status==='waiting'&&!paused)paused={reason:'unconfirmed',seconds:Math.max(1,Math.ceil((queued.retryAt-Date.now())/1000))};
  if(paused){if(queued.status==='review'){totals.review+=item.entries.length;continue;}queued.defer(paused.reason,paused.seconds);totals.waiting+=item.entries.length;continue;}
  try {
   sent++;const response=await send(item.body,item.source),text=await response.text();
   try{if(!response.ok)throw Error();confirmed(text,item.entries.length);}
   catch{
    const refusal=historyRefusal(text,response);
    if(refusal.reason==='closed'){queued.close();totals.refused+=item.entries.length;continue;}
    // Too large (0.10.29): marked and taken again at once, by the cut, never resent as it was. Without a cutter it waits.
    if(refusal.reason==='oversize'){queued.oversize();if(cutter){seen.delete(id);queue.unshift(id);}else totals.waiting+=item.entries.length;continue;}
    if(refusal.reason!=='review')paused={reason:refusal.reason,seconds:refusal.seconds>0?refusal.seconds:5};queued.defer(refusal.reason,paused?.seconds??refusal.seconds);totals[refusal.reason==='review'?'review':'waiting']+=item.entries.length;continue;
   }
   queued.confirm(item.entries.length);totals.received+=item.entries.length;note(text);
  }catch{paused={reason:'unconfirmed',seconds:5};queued.defer(paused.reason,paused.seconds);totals.waiting+=item.entries.length;}
 }
 return totals;
}
/** A queued batch's id, as queuedHistory names it, so a send can hand its own batches to resumeHistory (`only`). */
export const historyIdOf=(target,body,source)=>digest(scopeOf(target)+'\0'+source+'\0'+body);

/**
 * ONE LINE PER PROCESS PER DAY (0.10.33; owner, 2026-10-28; docs/FAIR-USE.md §1). An autonomous process (a headless or scheduled
 * session: `claude -p` from cron, an agent every ten minutes) writes a new transcript per run, and every run used to be a line
 * of its own: 144 a day for one process, a hundred processes 14,400. Its runs of one UTC day are one line now. A process is its
 * client, its session kind, its schedule (when the client names one) and its project folder, as a hash: never content, never the
 * path. The runs wait here, on disk, folded as they finish; the day is sent once it is over and quiet. A run is folded once (by
 * its id), and a run that finishes after its day was sent becomes the day's next part; once the database's PROCESS_PARTS are spent
 * it is merged into the last part, which goes again whole. Nothing is ever let go before WorkTrust took it.
 * Nothing here reads a transcript or the network: the hook hands it measured runs and sends what it answers.
 */
export const PROCESS_PARTS=3; // the database's analysis.process_day_max_parts()
const STEP=/(G?)([HIURATWhiuratw])([0-9]{1,6})/g;
const PART_CHARS=150_000; // a part stays well inside the door's 200,000 characters of timeline
const b64=s=>createHash('sha256').update(s).digest('base64url');
export const processRefOf=({source,kind,schedule,cwd,day})=>b64(`worktrust-process/1|${source??'claude'}|${kind}|${schedule??''}|${cwd?digest(String(cwd)):''}|${day}`);
export const lineRefOf=(ref,part)=>b64(`worktrust-process-line/1|${ref}|${part}`);
/** A run's timeline at MINUTE RESOLUTION: per wall-clock minute its first and its last step, each with its own kind.
 * A dropped step lies inside one minute between two kept ones, so every merged gap is under a minute, below the idle cap, and the
 * seconds WorkTrust counts from the timeline are exactly the same; a day holds at most two steps a minute (2,880). The calls of a
 * minute whose first and last steps are not the model's answers are not kept: a call counts at most once per five minutes anyway. */
export function minuteCompact(timeline,fromMs){return minuteCompactRun(timeline,fromMs).timeline;}
const ANSWER='ATW';
/** THE SAME, WITH WHAT RIDES ON THE STEPS (release 9 integration, 2026-10-29): 0.10.32's call outcomes (one character per
 * answer step, A/T/W) and input lengths (one bucket per H) are aligned with the timeline's steps, so a compacted timeline
 * carries exactly the outcomes of its kept answer steps and the lengths of its kept turns. Every H is kept (a person's turn
 * starts steered time: dropping one would move it), and in each minute the first answer recorded as completed ('1') is
 * kept beside the first and last step, so the guardrail never loses a positive call to the compaction. Seconds stay exact:
 * every kept set holds each minute's first and last step. Without outcomes or lengths, null comes back for them. */
export function minuteCompactRun(timeline,fromMs,outcomes=null,lengths=null){
 const steps=[...String(timeline).matchAll(STEP)].map(m=>({g:m[1],k:m[2],K:m[2].toUpperCase(),gap:Number(m[3])}));
 if(!steps.length)return {timeline:'',outcomes:outcomes==null?null:'',lengths:lengths==null?null:''};
 let c=0;const at=steps.map(s=>(c+=s.gap));const first=steps.findIndex(s=>s.k===s.K);const base=fromMs-1000*(at[Math.max(0,first)]??0);
 let ai=0,hi=0;const oc=steps.map(s=>ANSWER.includes(s.K)?(outcomes==null?null:String(outcomes)[ai++]??null):null);
 const lg=steps.map(s=>s.K==='H'?(lengths==null?null:String(lengths)[hi++]??null):null);
 const groups=new Map(),keep=new Set();
 steps.forEach((s,i)=>{const m=Math.floor((base+1000*at[i])/60_000),g=groups.get(m)??{first:i,last:i,done:-1};g.last=i;if(g.done<0&&oc[i]==='1')g.done=i;groups.set(m,g);});
 for(const g of groups.values()){keep.add(g.first);keep.add(g.last);if(g.done>=0)keep.add(g.done);}
 steps.forEach((s,i)=>{if(s.K==='H')keep.add(i);});
 let out='',o='',l='',gap=0;
 for(let i=0;i<steps.length;i++){gap+=i===0?0:steps[i].gap;if(!keep.has(i))continue;out+=`${steps[i].g}${steps[i].k}${Math.min(999999,gap)}`;gap=0;if(oc[i]!=null)o+=oc[i];if(lg[i]!=null)l+=lg[i];}
 return {timeline:out,outcomes:outcomes==null?null:o,lengths:lengths==null?null:l};
}
const stepsOf=(t,kinds)=>[...String(t??'').matchAll(STEP)].filter(m=>kinds.includes(m[2].toUpperCase())).length;
/** The runs of one part as ONE stretch: their timelines joined in time order, each run's first step at a zero gap (the time
 * between two runs belongs to neither, as it did when each was a line), a later run's bridge left out; tokens summed, the model
 * the one most runs used, the window from the first run's start to the last run's end. Release 9: the runs' call outcomes and
 * input lengths joined in the same order (a bridge left out takes its own character with it; a run whose steps carry none
 * makes the part carry none, never a misaligned string), and their subagent runs (wall-clock stamps) listed together. */
export function combineRuns(runs){
 const sorted=[...runs].sort((a,b)=>a.from-b.from),models=new Map();let timeline='',shapeKnown=true,outcomes='',lengths='',agents=[];
 const sum={tokensIn:0,tokensOut:0,cacheRead:0,cacheWrite:0};
 for(const [i,run] of sorted.entries()){
  let t=run.timeline,o=run.outcomes??null,l=run.lengths??null;
  if(o==null&&stepsOf(t,ANSWER)>0)outcomes=null;if(l==null&&stepsOf(t,'H')>0)lengths=null;
  if(i>0){const bridge=/^G?([hiuratw])[0-9]{1,6}/.exec(t);if(bridge){const K=bridge[1].toUpperCase();if(o!=null&&ANSWER.includes(K))o=o.slice(1);if(l!=null&&K==='H')l=l.slice(1);}
   t=t.replace(/^G?[hiuratw][0-9]{1,6}/,'').replace(/^(G?[HIURATW])[0-9]{1,6}/,(_,head)=>`${head}0`);}
  timeline+=t;if(outcomes!=null&&o!=null)outcomes+=o;if(lengths!=null&&l!=null)lengths+=l;
  for(const key of Object.keys(sum))sum[key]+=Number(run[key])||0;shapeKnown&&=run.shapeKnown!==false;
  if(run.model)models.set(run.model,(models.get(run.model)??0)+1);
  if(Array.isArray(run.agents))agents=agents.concat(run.agents);
 }
 return {...(shapeKnown?sum:{tokensIn:0,tokensOut:0,cacheRead:0,cacheWrite:0}),shapeKnown,timeline:timeline||null,model:[...models].sort((a,b)=>b[1]-a[1])[0]?.[0]??null,
  from:sorted[0]?.from,to:Math.max(...sorted.map(r=>r.to)),offset:sorted[0]?.offset,
  outcomes:outcomes&&outcomes.length===stepsOf(timeline,ANSWER)?outcomes:null,lengths:lengths&&lengths.length===stepsOf(timeline,'H')?lengths:null,
  agents:agents.length?{list:agents}:null};
}
/** A process-day's runs in time order, cut into parts whose timelines stay under PART_CHARS (one part on any real day). */
export function processParts(runs){
 const out=[];let part=[],chars=0;
 for(const run of [...runs].sort((a,b)=>a.from-b.from)){if(part.length&&chars+run.timeline.length>PART_CHARS){out.push(part);part=[];chars=0;}part.push(run);chars+=run.timeline.length;}
 if(part.length)out.push(part);
 return out;
}
/** One file per process-day under ~/.worktrust/process-days (a hundred processes stay a hundred small files), one lock. */
function processStore(){
 const home=join(homedir(),'.worktrust');directory(home);const root=join(home,'process-days');directory(root);
 const path=ref=>{if(!/^[A-Za-z0-9_-]{43}$/.test(ref))throw Error('PROCESS_DAY_UNSAFE');return join(root,ref+'.json');};
 return {root,load:ref=>read(path(ref)),save:(ref,value)=>write(path(ref),value),drop:ref=>{const p=path(ref);if(existsSync(p)){regular(p);unlinkSync(p);}},
  refs:()=>readdirSync(root).filter(f=>/^[A-Za-z0-9_-]{43}\.json$/.test(f)).map(f=>f.slice(0,43))};
}
/** Folds one finished run into its process-day, on disk, before the caller passes the transcript's mark. Idempotent by run id. */
export function foldProcessRun(key,run){
 const store=processStore();
 return reservation(store.root,()=>{
  const day=store.load(key.ref)??{format:'worktrust-process-day/1',day:key.day,source:key.source,kind:key.kind,cwd:key.cwd,steered:key.steered??null,schedule:key.schedule??null,codex:key.codex===true,sent:0,ids:[],runs:[]};
  const id=digest(run.id).slice(0,20);if(day.ids.includes(id))return 'held';
  day.ids.push(id);day.runs.push({...run,id});store.save(key.ref,day);return 'folded';
 });
}
/** The process-days to send now: the UTC day over and every run quiet for `quietMs`, not waiting on a retry; each as its parts
 * (runs cut so a part's timeline stays under PART_CHARS). A sent day is let go thirty days after it ends (its ids and last part kept till then, so a late run merges). */
export function dueProcessDays(now,quietMs){
 const store=processStore();
 return reservation(store.root,()=>{
  const out=[];
  for(const ref of store.refs()){
   const day=store.load(ref);if(!day)continue;
   const end=Date.parse(`${day.day}T00:00:00Z`)+86_400_000;
   if(!day.runs.length){if(now>end+30*86_400_000)store.drop(ref);continue;}
   if(now<end+quietMs||now-Math.max(...day.runs.map(r=>r.to))<quietMs||Number(day.retryAt)>now)continue;
   // THE PARTS ARE SPENT (the database holds PROCESS_PARTS lines of a day): a later run is MERGED into the last part, sent
   // again with every run it held, and the database puts the fuller line in its place. Nothing is ever let go unsent.
   const parts=processParts(day.runs),room=Math.max(0,PROCESS_PARTS-day.sent);
   if(room===0)out.push({ref,...day,part:PROCESS_PARTS,runs:[...(day.lastRuns??[]),...day.runs],pending:day.runs.map(r=>r.id)});
   else{const keep=parts.slice(0,room-1),rest=parts.slice(room-1).flat();keep.forEach((runs,i)=>out.push({ref,...day,part:day.sent+i+1,runs,pending:runs.map(r=>r.id)}));
    if(rest.length)out.push({ref,...day,part:day.sent+keep.length+1,runs:rest,pending:rest.map(r=>r.id)});}
  }
  return out;
 });
}
/** WorkTrust took the part: its new runs leave the pending list; the ids stay, so a run is never folded twice. */
export function markProcessSent(ref,due){
 const store=processStore();
 reservation(store.root,()=>{const day=store.load(ref);if(!day)return;const gone=new Set(due.pending);day.runs=day.runs.filter(r=>!gone.has(r.id));
  // The last part's runs stay (the day's own copy) until the day is let go: a run that comes later is merged into them.
  day.sent=Math.max(day.sent,due.part);if(due.part>=PROCESS_PARTS)day.lastRuns=due.runs;delete day.retryAt;store.save(ref,day);});
}
/** Not taken now (a limit, the network): kept, and asked again after `seconds`. */
export function deferProcessDay(ref,seconds){
 const store=processStore();
 reservation(store.root,()=>{const day=store.load(ref);if(!day)return;day.retryAt=Date.now()+Math.max(1,Math.min(MAX_RETRY_SECONDS,seconds))*1000;store.save(ref,day);});
}
