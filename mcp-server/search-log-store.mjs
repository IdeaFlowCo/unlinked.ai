import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, statfs, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { safeSearchRecord } from './search-activity.mjs'

export const SEARCH_LOG_CAP_BYTES = 1024 ** 3
export const SEARCH_LOG_SEGMENT_BYTES = 8 * 1024 ** 2
export const SEARCH_LOG_RESERVE_BYTES = 1024 ** 3
export const SEARCH_LOG_FILE = /^(?:requests-\d{4}-\d{2}-\d{2}|queries-\d{12})\.jsonl$/
export const SEARCH_LOG_INVENTORY_LIMIT = 4096
const STATUS = 'storage-status.json', TEMP = '.storage-status.tmp'
const validCount = n => Number.isSafeInteger(n) && n >= 0
const privateFile = info => info.isFile() && info.nlink === 1 && info.uid === process.getuid() && (info.mode & 0o777) === 0o600
export async function checkSearchLogDirectory(directory) {
  if (!isAbsolute(directory ?? '')) throw Error('search_log_directory_invalid')
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw Error('search_log_directory_not_private')
}
export function safeSearchLogStatus(value) {
  if (value?.schema !== 1 || value.event !== 'search_log_storage' || !['normal','warning','full','low_disk','unavailable'].includes(value.level) || typeof value.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.at) || !Number.isFinite(Date.parse(value.at))) return null
  const result = {schema:1,event:'search_log_storage',at:value.at,level:value.level}
  for (const key of ['used_bytes','cap_bytes','remaining_bytes','reserve_bytes','free_bytes','files','written','dropped','failures']) if (validCount(value[key])) result[key] = value[key]
  if (!result.cap_bytes || !validCount(result.used_bytes) || typeof value.paused !== 'boolean') return null
  result.paused = value.paused
  return result
}
export async function readSearchLogStatus({directory}) {
  await checkSearchLogDirectory(directory)
  const descriptor = await open(join(directory,STATUS),constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await descriptor.stat()
    if (!privateFile(info) || info.size > 4096) throw Error('search_log_status_not_private')
    const value = safeSearchLogStatus(JSON.parse(await descriptor.readFile('utf8')))
    if (!value) throw Error('search_log_status_invalid')
    return value
  } finally { await descriptor.close() }
}

// Single writer, no expiry and no automatic deletion. Daily v0.6.108 files are
// counted and preserved alongside bounded numbered segments. Only scalar
// storage state is visible to the existing private ops monitor.
export async function createSearchLogStore({directory,capBytes=SEARCH_LOG_CAP_BYTES,segmentBytes=SEARCH_LOG_SEGMENT_BYTES,reserveBytes=SEARCH_LOG_RESERVE_BYTES,maxQueue=128,now=()=>new Date(),freeBytes=async()=>{const fs=await statfs(directory);return fs.bavail*fs.bsize},statusIntervalMs=60000}={}) {
  if (!isAbsolute(directory??'') || !validCount(capBytes) || capBytes<1024 || capBytes>16*1024**3 || !validCount(segmentBytes) || segmentBytes<512 || segmentBytes>SEARCH_LOG_SEGMENT_BYTES || !validCount(reserveBytes) || !validCount(maxQueue) || maxQueue<1 || maxQueue>128 || !validCount(statusIntervalMs) || statusIntervalMs<100) throw Error('search_log_store_configuration_invalid')
  await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
  await checkSearchLogDirectory(directory)
  const names=await readdir(directory)
  if(names.length>SEARCH_LOG_INVENTORY_LIMIT)throw Error('search_log_inventory_limit')
  let used=0,files=0,index=0,currentSize=0,current=null,closed=false,pending=0,chain=Promise.resolve(),dirty=true
  let free=await freeBytes(),lastFreeCheck=Date.now(),droppedSinceWrite=0,blocked=false,lowDisk=false,unavailable=false
  const stats={written:0,dropped:0,failures:0}
  for(const name of names){
    const info=await lstat(join(directory,name))
    if(!privateFile(info))throw Error('search_log_file_not_private')
    if(SEARCH_LOG_FILE.test(name)){
      if(info.size>SEARCH_LOG_SEGMENT_BYTES)throw Error('search_log_segment_limit')
      used+=info.size;files++
      if(name.startsWith('queries-')){const n=Number(name.slice(8,20));if(n>=index){index=n;current=name;currentSize=info.size}}
    }else if(![STATUS,TEMP].includes(name))throw Error('search_log_inventory_invalid')
  }
  if(names.includes(TEMP))await unlink(join(directory,TEMP))
  // Keep omission totals across normal restarts. File sizes remain authoritative.
  if(names.includes(STATUS)){
    const old=await readSearchLogStatus({directory})
    stats.dropped=old.dropped??0;stats.failures=old.failures??0
    blocked=old.level==='full'&&old.cap_bytes===capBytes&&old.used_bytes===used
  }
  const level=()=>unavailable?'unavailable':used>=capBytes||blocked?'full':lowDisk||free<reserveBytes?'low_disk':used>=Math.floor(capBytes*.8)?'warning':'normal'
  const status=()=>safeSearchLogStatus({schema:1,event:'search_log_storage',at:now().toISOString(),level:level(),used_bytes:used,cap_bytes:capBytes,remaining_bytes:Math.max(0,capBytes-used),reserve_bytes:reserveBytes,free_bytes:Math.max(0,Math.floor(free)),files,...stats,paused:['full','low_disk','unavailable'].includes(level())})
  async function publish(){
    if(!dirty)return
    // Atomic status replacement never follows a caller-selected path or symlink.
    for(const name of [STATUS,TEMP]){
      try{if(!privateFile(await lstat(join(directory,name))))throw Error('search_log_status_not_private')}
      catch(error){if(error.code!=='ENOENT')throw error}
    }
    const fd=await open(join(directory,TEMP),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
    try{await fd.writeFile(JSON.stringify(status())+'\n');await fd.sync()}finally{await fd.close()}
    await rename(join(directory,TEMP),join(directory,STATUS));dirty=false
  }
  await publish()
  const lose=()=>{stats.dropped++;droppedSinceWrite++;dirty=true}
  const timer=setInterval(()=>{
    if(closed||pending>=maxQueue)return
    pending++
    chain=chain.then(async()=>{free=await freeBytes();lowDisk=free<reserveBytes+4096;lastFreeCheck=Date.now();dirty=true;await publish()}).catch(()=>{stats.failures++;unavailable=true;dirty=true}).finally(()=>pending--)
  },statusIntervalMs);timer.unref()
  return {
    emit(record){
      if(closed||pending>=maxQueue||blocked||lowDisk||unavailable){lose();return}
      const safe=safeSearchRecord(record)
      if(!safe){lose();return}
      pending++
      chain=chain.then(async()=>{
        const line=JSON.stringify({...safe,sink_dropped_since_last_write:droppedSinceWrite})+'\n',size=Buffer.byteLength(line)
        if(Date.now()-lastFreeCheck>=1000||free-size<reserveBytes){free=await freeBytes();lastFreeCheck=Date.now()}
        const before=level()
        if(size>4096||size>segmentBytes){lose();return}
        if(used+size>capBytes||blocked){blocked=true;lose();await publish();return}
        if(free-size<reserveBytes||unavailable){if(free-size<reserveBytes)lowDisk=true;lose();dirty=true;await publish();return}
        if(!current||currentSize+size>segmentBytes){
          if(files>=SEARCH_LOG_INVENTORY_LIMIT-2)throw Error('search_log_inventory_limit')
          index++;current=`queries-${String(index).padStart(12,'0')}.jsonl`;currentSize=0;files++
        }
        const fd=await open(join(directory,current),constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
        try{
          const info=await fd.stat()
          if(!privateFile(info)||info.size!==currentSize)throw Error('search_log_writer_conflict')
          // Include any partial append in accounting even after an IO error.
          try{await fd.writeFile(line)}finally{const next=await fd.stat();used+=next.size-currentSize;currentSize=next.size}
          free=Math.max(0,free-size);stats.written++;droppedSinceWrite=0;dirty=true
        }finally{await fd.close()}
        if(level()!==before)await publish()
      }).catch(async()=>{lose();stats.failures++;unavailable=true;try{await publish()}catch{}}).finally(()=>pending--)
    },
    async flush(){chain=chain.then(publish);await chain},
    async close(){closed=true;clearInterval(timer);await chain;await publish()},
    stats:()=>({...status(),pending}),
  }
}
