/* Primeval's static-host isolation worker (MIT, pinned 0.2.2 demo/coi-sw.js).
 * Network-only: no asset caching, no upload interception, same-origin scope.
 */
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(new URL(request.url).origin!==self.location.origin)return;
  if(request.cache==="only-if-cached"&&request.mode!=="same-origin")return;
  event.respondWith(fetch(request).then(response=>{
    if(response.status===0||response.type==="opaqueredirect")return response;
    const headers=new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy","same-origin");
    headers.set("Cross-Origin-Embedder-Policy","require-corp");
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }));
});
