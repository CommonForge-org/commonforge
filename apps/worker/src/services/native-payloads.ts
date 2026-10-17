/** Digest-verified scoped evidence bytes. Existing GC never scans this dedicated prefix. */
import { sha256HexSync,type ProjectState } from '@commonforge-org/core';
import type { ProjectBundlePayload } from '@commonforge-org/ledger';
import type { Services } from '../context.js';
import { ApiError,conflict,notFound } from '../lib/http.js';
export const NATIVE_PAYLOAD_MAX_BYTES=1048576;
export const nativePayloadKey=(org:string,pid:string,digest:string)=>`native-evidence/${org}/${pid}/${digest}`;
export interface NativePayloadMetadata {digest:string;size:number;mediaType:string;state:'active'|'deleted'}
export async function putNativePayload(svc:Services,org:string,pid:string,actorId:string,digest:string,content:Uint8Array,mediaType:string) {
 if(content.byteLength>NATIVE_PAYLOAD_MAX_BYTES)throw new ApiError(413,'payload_too_large','evidence attachments are at most 1 MiB');
 if(!/^[a-f0-9]{64}$/.test(digest)||sha256HexSync(content)!==digest)throw conflict('payload_digest_mismatch','attachment bytes do not match path digest');
 if(!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[ -~]*)?$/.test(mediaType)||mediaType.length>256)throw new ApiError(400,'invalid_request','valid attachment Content-Type required');
 const existing=await svc.ledger(org).getNativePayload(pid,digest);
 if(existing){const record=JSON.parse(existing) as NativePayloadMetadata;if(record.state==='deleted'||record.size!==content.byteLength||record.mediaType!==mediaType)throw conflict('revision_conflict','payload was deleted or metadata differs');}
 // Blob preparation precedes registry commit. Failure leaves no accepted reference; an RPC
 // failure may leave an orphan but never deletes an existing evidence payload.
 await svc.env.COMMONFORGE_ASSETS.put(nativePayloadKey(org,pid,digest),content,{httpMetadata:{contentType:mediaType}});
 return JSON.parse(await svc.ledger(org).registerNativePayload(org,pid,actorId,{digest,size:content.byteLength,mediaType}));
}
export async function readNativePayload(svc:Services,org:string,pid:string,digest:string) {
 const raw=await svc.ledger(org).getNativePayload(pid,digest);const metadata=raw?JSON.parse(raw) as NativePayloadMetadata:null;
 if(!metadata||metadata.state!=='active')throw notFound('attachment not found');
 const object=await svc.env.COMMONFORGE_ASSETS.get(nativePayloadKey(org,pid,digest));if(!object)throw new ApiError(409,'payload_missing','registered attachment bytes are unavailable');
 const content=new Uint8Array(await object.arrayBuffer());if(content.byteLength!==metadata.size||sha256HexSync(content)!==digest)throw conflict('payload_digest_mismatch','stored attachment failed integrity verification');
 return {metadata,content};
}
export async function deleteNativePayload(svc:Services,org:string,pid:string,actorId:string,digest:string) {
 // Tombstone first, atomically excluding every existing evidence reference. A concurrent
 // evidence write then sees deleted and refuses. Repeated DELETE retries any failed R2 delete.
 const result=JSON.parse(await svc.ledger(org).deleteNativePayload(org,pid,actorId,digest));
 await svc.env.COMMONFORGE_ASSETS.delete(nativePayloadKey(org,pid,digest));return result;
}
function base64(bytes:Uint8Array){let value='';for(let offset=0;offset<bytes.length;offset+=32768)value+=String.fromCharCode(...bytes.subarray(offset,offset+32768));return btoa(value);}
/** Export only exact digests referenced by this authorized project history. Missing objects stay
 * absent so exportProjectBundle reports them in missingAttachments instead of inventing bytes. */
export async function exportNativePayloads(svc:Services,org:string,pid:string,state:ProjectState):Promise<ProjectBundlePayload[]> {
 if(state.organizationId!==org||state.projectId!==pid)throw conflict('bundle_invalid','export scope mismatch');
 const descriptors=[...new Map(state.evidence.flatMap(e=>e.attachments).map(a=>[a.digest,a])).values()];const payloads:ProjectBundlePayload[]=[];
 for(const attachment of descriptors){
  try{const {metadata,content}=await readNativePayload(svc,org,pid,attachment.digest);if(metadata.size!==attachment.size||metadata.mediaType!==attachment.mediaType)throw conflict('bundle_invalid','attachment metadata changed');payloads.push({kind:'attachment',subject:attachment.digest,path:`payloads/${attachment.digest}`,digest:attachment.digest,size:metadata.size,mediaType:metadata.mediaType,contentBase64:base64(content)});}
  catch(e){if(e instanceof ApiError&&(e.code==='payload_missing'||e.code==='not_found'))continue;throw e;}
 }
 return payloads;
}
