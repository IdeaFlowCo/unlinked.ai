import { bulkExportInput } from './bulk-exports.mjs'
import { scopeAllowsPrivateNotes, scopeCoversPublic } from './account-grants.mjs'
export function createBulkExportHttp({ origin, authenticateGrant, exports, service }) {
  const base=new URL(origin)
  return async(request,response)=>{
    response.setHeader('Cache-Control','no-store, private')
    if(request.headers.host!==base.host || request.headers.origin&&request.headers.origin!==base.origin){response.writeHead(403).end();return}
    if(request.method!=='GET'){response.writeHead(405,{Allow:'GET'}).end();return}
    let grant
    try{grant=await authenticateGrant(request)}catch{response.writeHead(503).end();return}
    if(!grant){response.writeHead(401).end();return}
    const controller=new AbortController();response.once('close',()=>{if(!response.writableFinished)controller.abort()})
    const authorize=async()=>{const current=await authenticateGrant(request);if(!current||current.grantId!==grant.grantId||current.ownerId!==grant.ownerId||current.userId!==grant.userId||current.scope!==grant.scope||!current.tools.includes('unlinked_export_network'))throw Object.assign(Error('Export permission was removed.'),{code:'grant_revoked'})}
    try{
      const input=bulkExportInput(new URL(request.url,base).searchParams)
      await service.call({grant,name:'unlinked_export_network',input:{scope:input.scope,query:input.query,format:input.format,detail:input.detail,ids:input.ids,fields:input.fields,...(input.listId?{listId:input.listId}:{}),...(input.presence?{presence:input.presence}:{}),mode:input.mode,...input.filters},signal:controller.signal,revalidate:async()=>{await authorize();return grant}})
      await exports.stream({owner:grant,input:new URL(request.url,base).searchParams,policy:{publicAllowed:scopeCoversPublic(grant.scope),privateAllowed:scopeAllowsPrivateNotes(grant.scope),browser:false},authorize,response,signal:controller.signal})
    }catch(error){
      if(response.headersSent){response.destroy();return}
      const status={not_found:404,invalid_input:400,scope_not_granted:403,grant_revoked:401,rate_limited:429}[error?.code]??503
      response.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify({error:{code:error?.code??'upstream_unavailable',message:status===503?'The download could not start; retry.':error.message}}))
    }
  }
}
