import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { environment, fetchSubscription, TunGuard } from '../electron/network.mjs';
import { parseSubscription, buildConfig } from '../electron/profiles.mjs';
import { nativeRequest, proxyRequest, freePorts } from '../electron/engine.mjs';
import { redact } from '../electron/controller.mjs';
const root=process.cwd(), exec=promisify(execFile), report={steps:[],logs:[]};
const dir=await mkdtemp(path.join(os.tmpdir(),'joxy-tun-diagnose-'));
const guard=new TunGuard(path.join(root,'resources/windows-tun.ps1'),dir);
let child;
const step=async(name,fn)=>{try{const value=await fn();report.steps.push({name,ok:true,value});}catch(e){report.steps.push({name,ok:false,error:redact(e.message)});}};
try {
 const env=await environment(); if(!env.elevated)throw Error('Administrator required');
 if(env.tunActive)throw Error('Exit the other VPN before diagnosing JOXY TUN.');
 report.environment=env;
 const privateConfig=JSON.parse(await readFile(process.env.JOXY_SUBSCRIPTION_FILE,'utf8'));
 const profiles=parseSubscription((await fetchSubscription(privateConfig.subscriptionUrl)).body).profiles;
 const p=profiles.find(p=>p.transport==='xhttp');
 const [http,socks,metrics]=await freePorts();const ports={http,socks,metrics};
 const config=buildConfig(p,ports,env.interface,{mode:'tun'});config.log.loglevel='debug';
 await writeFile(path.join(dir,'runtime.json'),JSON.stringify(config));
 await guard.prepare(env.weakHostSend || []);
 child=spawn(path.join(root,'resources/xray/xray.exe'),['run','-config',path.join(dir,'runtime.json')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 const log=c=>report.logs.push(redact(c.toString()));child.stdout.on('data',log);child.stderr.on('data',log);
 await guard.track(child.pid,path.join(root,'resources/xray/xray.exe'));await new Promise(r=>setTimeout(r,3000));
 await step('https-ip',async()=>{const r=await nativeRequest('https://1.1.1.1/cdn-cgi/trace',8000);return {status:r.status,body:r.body};});
 await step('virtual-dns',async()=>{const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','Resolve-DnsName example.com -Type A -DnsOnly -Server 172.31.255.2 | ConvertTo-Json -Compress'],{windowsHide:true,timeout:12000});return r.stdout;});
 await step('https-domain',async()=>{const r=await nativeRequest('https://www.gstatic.com/generate_204',8000);return {status:r.status};});
 await step('https-local-proxy',async()=>{const r=await proxyRequest(http,'https://www.gstatic.com/generate_204',8000);return {status:r.status};});
 await step('routes',async()=>{const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-NetRoute -InterfaceAlias JOXY | Select-Object DestinationPrefix,NextHop,RouteMetric | ConvertTo-Json -Compress"],{windowsHide:true,timeout:12000});return r.stdout;});
}catch(e){report.error=redact(e.message);}
finally{
 if(child){child.kill();await new Promise(r=>child.exitCode===null?child.once('exit',r):r());}
 await guard.restore().catch(e=>report.cleanupError=redact(e.message));
 await rm(path.join(dir,'runtime.json'),{force:true});
 await writeFile(path.join(os.tmpdir(),'joxy-tun-verification','diagnostics.json'),JSON.stringify(report,null,2));
}
