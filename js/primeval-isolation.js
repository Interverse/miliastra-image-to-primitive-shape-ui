/* Enable multi-core WASM on GitHub Pages, which cannot set response headers.
 * Upgrade at initial load only; never reload after file selection or editing.
 * The unshared SIMD build remains available if service workers are disabled.
 */
window.primevalIsolationReady=(async()=>{
  if(globalThis.crossOriginIsolated||!navigator.serviceWorker||!isSecureContext)return;
  let interacted=false;
  const mark=()=>{interacted=true;};
  for(const type of ["pointerdown","keydown","drop","paste"])addEventListener(type,mark,{once:true,capture:true});
  try{
    const hadController=Boolean(navigator.serviceWorker.controller);
    await navigator.serviceWorker.register(new URL("../coi-sw.js",document.currentScript?.src||location.href),{updateViaCache:"none"});
    if(hadController)return;
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller)await new Promise(resolve=>navigator.serviceWorker.addEventListener("controllerchange",resolve,{once:true}));
    if(!interacted&&!sessionStorage.getItem("primeval-isolation-reloaded")){
      sessionStorage.setItem("primeval-isolation-reloaded","1");location.reload();
    }
  }catch{ /* The original single-threaded engine is an output-equivalent fallback. */ }
})();
