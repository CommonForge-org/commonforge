import { Hono } from 'hono';
import type { AppEnv } from '../context.js';
import { ApiError,badRequest } from '../lib/http.js';
import { orgActor } from '../middleware/authz.js';
import { nativeState } from './native-projects.js';
import { deleteNativePayload,NATIVE_PAYLOAD_MAX_BYTES,putNativePayload,readNativePayload } from '../services/native-payloads.js';
export const nativePayloadRoutes=new Hono<AppEnv>();
const path='/orgs/:org/projects/:pid/native/attachments/:digest';
const digest=(value:string)=>{if(!/^[a-f0-9]{64}$/.test(value))throw badRequest('invalid_request','attachment digest must be SHA-256');return value;};
nativePayloadRoutes.put(path,async c=>{
 const actor=await orgActor(c,c.req.param('org'),['owner','developer']);const pid=c.req.param('pid');if(!await nativeState(c,actor,pid))throw badRequest('project_mode_unsupported','enable the project before uploading evidence');
 const declared=Number(c.req.header('content-length'));if(Number.isFinite(declared)&&declared>NATIVE_PAYLOAD_MAX_BYTES)throw new ApiError(413,'payload_too_large');
 // Bound the stream before buffering; Content-Length is not trusted.
 const reader=c.req.raw.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
 if(reader)for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>NATIVE_PAYLOAD_MAX_BYTES){await reader.cancel();throw new ApiError(413,'payload_too_large');}chunks.push(next.value);}
 const content=new Uint8Array(size);let offset=0;for(const chunk of chunks){content.set(chunk,offset);offset+=chunk.byteLength;}
 const result=await putNativePayload(c.get('svc'),actor.orgId,pid,actor.userId,digest(c.req.param('digest')),content,c.req.header('content-type')??'application/octet-stream');return c.json(result,result.replayed?200:201);
});
nativePayloadRoutes.get(path,async c=>{
 const actor=await orgActor(c,c.req.param('org'),['owner','developer']);const pid=c.req.param('pid');await nativeState(c,actor,pid);const {metadata,content}=await readNativePayload(c.get('svc'),actor.orgId,pid,digest(c.req.param('digest')));
 return new Response(content,{headers:{'content-type':metadata.mediaType,'content-length':String(metadata.size),'content-disposition':'attachment','cache-control':'private, no-store','x-content-type-options':'nosniff','x-commonforge-sha256':metadata.digest}});
});
nativePayloadRoutes.delete(path,async c=>{
 const actor=await orgActor(c,c.req.param('org'),['owner','developer']);const pid=c.req.param('pid');await nativeState(c,actor,pid);return c.json(await deleteNativePayload(c.get('svc'),actor.orgId,pid,actor.userId,digest(c.req.param('digest'))));
});
