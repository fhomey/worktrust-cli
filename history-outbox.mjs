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
 if(acknowledged?.id===id)return {status:'acknowledged',confirm(){},defer(){}};
 const current=read(state);
 reservation(root,()=>{
 if(!existsSync(request)) {
  const files=readdirSync(root);let bytes=0,pending=0;
  for(const file of files) {const stat=regular(join(root,file));bytes+=stat.size;if(file.endsWith('.request.json'))pending++;}
  if(files.length>=12000||pending>=512||bytes+Buffer.byteLength(JSON.stringify({id,scope,source,body}))+1024>64*1024*1024)throw Error('HISTORY_QUEUE_FULL');
  write(request,{id,scope,source,body});
 } else if(read(request)?.body!==body)throw Error('HISTORY_QUEUE_CHANGED');
 });
 const status=current?.status==='review'?'review':Number(current?.retryAt)>Date.now()?'waiting':'pending';
 return {status,retryAt:current?.retryAt??null,
  confirm(){write(ack,{id,confirmedAt:new Date().toISOString()});if(existsSync(request)){regular(request);unlinkSync(request);}if(existsSync(state)){regular(state);unlinkSync(state);}},
  defer(reason,seconds=0){if(existsSync(ack))return;write(state,{id,status:reason==='review'?'review':'retry',retryAt:Date.now()+Math.max(0,Math.min(MAX_RETRY_SECONDS,seconds))*1000});},
 };
}
export function historyRefusal(text,response) {
 let rpc;
 try {rpc=JSON.parse(text.trim().startsWith('{')?text:text.split(/\r?\n/).find(s=>s.startsWith('data:'))?.slice(5));}catch{/* Unknown reply stays retryable, never acknowledged. */}
 const review=rpc?.id===1 && (rpc?.error?.data?.outcome==='review' || String(rpc?.error?.message??'').startsWith('history replacement held for review:'));
 const raw=Number(response.headers.get('retry-after'));
 return {reason:review?'review':response.status===429?'capacity':'unconfirmed',seconds:Number.isFinite(raw)&&raw>0?Math.min(MAX_RETRY_SECONDS,raw):0};
}

/** Explicit recovery, even after the AI client removed its source files. A changed account/key
 * cannot replay another coupling's pending data. Review is retried only on an explicit request. */
export async function resumeHistory(target, {send, confirmed, note, retryReview=false, dry=false}) {
 const root=join(homedir(),'.worktrust','history-outbox'),scope=scopeOf(target);
 const totals={received:0,review:0,waiting:0,batches:0};let paused=null;
 if(!existsSync(root))return totals;
 directory(root);
 const files=readdirSync(root);if(files.length>12000)throw Error('HISTORY_QUEUE_FULL');
 for(const file of files.sort()) {
  if(!/^[a-f0-9]{64}\.request\.json$/.test(file))continue;
  const item=read(join(root,file));if(item?.scope!==scope)continue;
  if(typeof item.body!=='string'||typeof item.source!=='string'||item.id!==digest(scope+'\0'+item.source+'\0'+item.body)||file!==item.id+'.request.json')throw Error('HISTORY_QUEUE_CHANGED');
  const rpc=JSON.parse(item.body),entries=rpc?.params?.arguments?.entries;
  if(rpc.jsonrpc!=='2.0'||rpc.id!==1||rpc.method!=='tools/call'||rpc.params.name!=='import_history'||!Array.isArray(entries)||!entries.length||entries.length>200)throw Error('HISTORY_QUEUE_CHANGED');
  const queued=queuedHistory(target,item.body,item.source);totals.batches++;
  if(queued.status==='acknowledged')continue;
  if(queued.status==='review'&&!retryReview){totals.review+=entries.length;continue;}
  if(dry){totals.waiting+=entries.length;continue;}
  if(queued.status==='waiting'&&!paused)paused={reason:'unconfirmed',seconds:Math.max(1,Math.ceil((queued.retryAt-Date.now())/1000))};
  if(paused){if(queued.status==='review'){totals.review+=entries.length;continue;}queued.defer(paused.reason,paused.seconds);totals.waiting+=entries.length;continue;}
  try {
   const response=await send(item.body,item.source),text=await response.text();
   try{if(!response.ok)throw Error();confirmed(text,entries.length);}
   catch{const refusal=historyRefusal(text,response);if(refusal.reason!=='review')paused={reason:refusal.reason,seconds:refusal.seconds>0?refusal.seconds:5};queued.defer(refusal.reason,paused?.seconds??refusal.seconds);totals[refusal.reason==='review'?'review':'waiting']+=entries.length;continue;}
   queued.confirm();totals.received+=entries.length;note(text);
  }catch{paused={reason:'unconfirmed',seconds:5};queued.defer(paused.reason,paused.seconds);totals.waiting+=entries.length;}
 }
 return totals;
}
