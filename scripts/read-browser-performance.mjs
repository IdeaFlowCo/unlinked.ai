#!/usr/bin/env node
import { constants } from 'node:fs'
import { lstat, readdir, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { safeDiagnosticRecord } from '../mcp-server/request-diagnostics.mjs'
const percentile = (values, p) => values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1] : null
export function summarizeBrowserPerformance(records) {
 const groups=new Map();let dropped=0,first=null,last=null,accepted=0
 for (const value of records) {
  const row=safeDiagnosticRecord(value);if(row?.event!=='browser_performance')continue
  accepted++;dropped+=(row.dropped_since_last_emit??0)+(Number.isSafeInteger(value.sink_dropped_since_last_write)?value.sink_dropped_since_last_write:0)
  if(!first||row.at<first)first=row.at;if(!last||row.at>last)last=row.at
  const key=[row.release,row.route,row.metric,row.start].join(':'),group=groups.get(key)??{release:row.release,route:row.route,metric:row.metric,start:row.start,ok:0,error:0,cancelled:0,capped:0,latencies:[],ttfb:[],render:[]}
  group[row.outcome]++;if(row.duration_capped)group.capped++
  if(row.outcome==='ok'){group.latencies.push(row.duration_ms);if(row.ttfb_ms!==undefined)group.ttfb.push(row.ttfb_ms);if(row.render_ms!==undefined)group.render.push(row.render_ms)}
  groups.set(key,group)
 }
 return {records:accepted,first_at:first,last_at:last,reported_drops:dropped,groups:[...groups.values()].map(({latencies,ttfb,render,...g})=>({...g,p50_ms:percentile(latencies,.5),p95_ms:percentile(latencies,.95),p99_ms:percentile(latencies,.99),max_ms:latencies.length?latencies.reduce((max,value)=>Math.max(max,value),0):null,over_2s:latencies.filter(x=>x>2000).length,ttfb_p95_ms:percentile(ttfb,.95),render_p95_ms:percentile(render,.95)})).sort((a,b)=>(b.p95_ms??0)-(a.p95_ms??0))}
}
export async function readBrowserPerformance({directory,since}) {
 if(!isAbsolute(directory??'')||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(since??'')||!Number.isFinite(Date.parse(since)))throw Error('performance_directory_and_since_required')
 const state=await lstat(directory)
 if(!state.isDirectory()||state.isSymbolicLink()||state.uid!==process.getuid()||(state.mode&0o777)!==0o700)throw Error('performance_directory_not_private')
 const files=await readdir(directory),records=[]
 if(files.length>64)throw Error('performance_inventory_limit')
 const days=files.filter(x=>/^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort();if(days.length>7)throw Error('performance_retention_limit')
 for(const name of days){
  const file=await open(join(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW)
  try{
   const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o600||stat.size>8*1024*1024)throw Error('performance_file_not_private')
   for(const line of (await file.readFile('utf8')).split('\n')){
    if(!line||Buffer.byteLength(line)>4096)continue
    try{const row=JSON.parse(line);if(row.event==='browser_performance'&&Date.parse(row.at)>=Date.parse(since))records.push(row)}catch{}
   }
  }finally{await file.close()}
 }
 return {since,...summarizeBrowserPerformance(records),coverage:'Observed browser beacons only; seven-day retention, 300 accepted/minute, 8 MiB/day. Hidden tabs, blocked/lost beacons and pages without script are not measured.'}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const flags={'--directory':'directory','--since':'since'},options={};for(let i=2;i<process.argv.length;i+=2){const key=flags[process.argv[i]];if(!key||options[key]||!process.argv[i+1])throw Error('invalid_arguments');options[key]=process.argv[i+1]}console.log(JSON.stringify(await readBrowserPerformance(options),null,2))}catch{console.error('Browser performance report unavailable: supply an owned private --directory and UTC --since.');process.exitCode=1}
}
