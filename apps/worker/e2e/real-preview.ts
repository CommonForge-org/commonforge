/** Real local R2 preview, with standalone Node API modules in mount/PID/network namespaces. */
import { handlePreviewRequest } from '../src/preview/handler.js';
import { previewPrefix } from '../src/lib/preview-token.js';
import { isLocalUrl } from '../src/lib/local-host.js';
interface Env { COMMONFORGE_ASSETS: R2Bucket; COMMONFORGE_PREVIEW_KEY: string; COMMONFORGE_LOCAL_PREVIEW_URL: string; COMMONFORGE_LOCAL_PREVIEW_KEY: string }
export default { fetch(request: Request, env: Env) {
  return handlePreviewRequest(request, { bucket: env.COMMONFORGE_ASSETS, key: env.COMMONFORGE_PREVIEW_KEY, now: () => Date.now(), box: () => ({
    async serve(meta, request) {
      if (!isLocalUrl(env.COMMONFORGE_LOCAL_PREVIEW_URL)) return new Response('local preview unavailable', {status:503});
      const prefix = `${previewPrefix(meta.orgId,meta.previewId)}bundles/${meta.bundles[0]}/`;
      const module = await env.COMMONFORGE_ASSETS.get(`${prefix}worker.mjs`) ?? await env.COMMONFORGE_ASSETS.get(`${prefix}index.js`);
      if (!module || module.size > 1048576) return new Response('standalone preview module unavailable', {status:503});
      const bytes = new Uint8Array(await module.arrayBuffer()); let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
      const response = await fetch(`${env.COMMONFORGE_LOCAL_PREVIEW_URL}/serve`, { method:'POST', headers:{authorization:`Bearer ${env.COMMONFORGE_LOCAL_PREVIEW_KEY}`,'content-type':'application/json'}, body:JSON.stringify({module:btoa(binary),path:new URL(request.url).pathname,method:request.method,...(request.method==='POST'?{body:await request.text()}:{})}),signal:AbortSignal.timeout(10000)});
      if(!response.ok)return new Response('isolated API preview unavailable',{status:503});
      const result=await response.json() as {status:number;headers:Record<string,string>;body:string};
      return new Response(Uint8Array.from(atob(result.body),c=>c.charCodeAt(0)),{status:result.status,headers:result.headers});
    },
  }) });
} };
