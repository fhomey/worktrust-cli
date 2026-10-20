/** Official launcher, disposable signing key and synthetic home: no user records or live network. */
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
const root=mkdtempSync(join(tmpdir(),'wt-execution-boundary-')), pkg=join(root,'package'), home=join(root,'home');
const pair=generateKeyPairSync('ed25519'), pem=pair.publicKey.export({type:'spki',format:'pem'});
const hash=b=>createHash('sha256').update(b).digest('hex');
const id=hash(pair.publicKey.export({type:'spki',format:'der'})), roots={[id]:pem};
const canonical=x=>x&&typeof x==='object'?(Array.isArray(x)?'['+x.map(canonical).join(',')+']':'{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}'):JSON.stringify(x);
const source=process.env.WORKTRUST_TEST_CLI_SOURCE || 'tools/worktrust-cli';
const metadata=JSON.parse(readFileSync(join(source,'package.json'))), version=metadata.version;
const seal=(kind,files)=>{const payload={format:'worktrust-package/1',kind,version,files};return JSON.stringify({keyId:id,payload,signature:sign(null,Buffer.from('worktrust:package:1\n'+canonical(payload)),pair.privateKey).toString('base64url')});};
mkdirSync(pkg);mkdirSync(join(home,'.worktrust'),{recursive:true});
for(const name of [...new Set(['package.json',...metadata.files])].filter(n=>existsSync(join(source,n)))){
 let data=readFileSync(join(source,name));
 if(['package-integrity.mjs','worktrust-launch.mjs'].includes(name))data=Buffer.from(data.toString().replace(/^(export )?const RELEASE_KEYS = .*; \/\/ GENERATED_RELEASE_KEYS$/m,(_,exp)=>(exp??'')+'const RELEASE_KEYS = '+JSON.stringify(roots)+'; // GENERATED_RELEASE_KEYS'));
 writeFileSync(join(pkg,name),data);
}
const inventory=filter=>Object.fromEntries(readdirSync(pkg).filter(filter).map(n=>[n,hash(readFileSync(join(pkg,n)))]));
writeFileSync(join(pkg,'engine-release.json'),seal('engine',inventory(n=>n.endsWith('.mjs'))));
writeFileSync(join(pkg,'package-release.json'),seal('npm',inventory(n=>n!=='package-release.json')));
const marker=join(root,'UNTRUSTED_COUNTER_EXECUTED');
writeFileSync(join(home,'.worktrust','count-behaviour.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');`);
writeFileSync(join(home,'.worktrust','pinned'),'old pinned copy');
writeFileSync(join(home,'.worktrust','key.json'),Buffer.from(JSON.stringify({token:'wt_synthetic',url:'http://127.0.0.1:1/api/mcp',renewedAt:new Date().toISOString()})).toString('base64'));
const run=args=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[join(pkg,'worktrust-launch.mjs'),...args],{env:{...process.env,HOME:home,USERPROFILE:home,WORKTRUST_HOOK_INPUT:'',WORKTRUST_MCP_URL:'',WORKTRUST_MCP_TOKEN:''},stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);child.on('error',reject);child.on('close',code=>resolve({code,out}));});
try{
 const result=await run(['hook']);assert.equal(result.code,0,result.out);
 await new Promise(resolve=>setTimeout(resolve,800));
 assert.equal(existsSync(marker),false,'official unchanged launcher must never execute the loose home counter');
 const invalid=await run(['--internal-module','../untrusted.mjs']);assert.notEqual(invalid.code,0);assert.match(invalid.out,/PACKAGE_INVALID_ENTRY/);
 let checked=0;
 for(const name of readdirSync(pkg).filter(n=>n.endsWith('.mjs'))){
   const original=readFileSync(join(pkg,name));
   // The bootstrap itself is the trust boundary, not something a modified bootstrap can authenticate.
   if(name==='worktrust-launch.mjs')continue;
   writeFileSync(join(pkg,name),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'changed release');`);
   const changed=await run(['--version']);
   writeFileSync(join(pkg,name),original);
   assert.notEqual(changed.code,0,name);assert.match(changed.out,/PACKAGE_FILE_CHANGED/,name);assert(!existsSync(marker),name);checked++;
 }
 console.log(`PASS: poisoned home counter ignored; ${checked} changed release modules rejected; internal traversal refused`);
}finally{rmSync(root,{recursive:true,force:true});}
