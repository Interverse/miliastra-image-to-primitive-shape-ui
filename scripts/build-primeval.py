"""Build the pinned SIMD WASM engine. No generated files or tools outside workspace."""
from pathlib import Path
import os,subprocess,shutil,sys
root=next(p for p in Path(__file__).resolve().parents if (p/'index.html').is_file() and (p/'js/app.js').is_file());work=root/'reference/research-2026-10/primeval-constrained'
source=Path(__file__).resolve().parents[1]/'third_party/primeval';vendor=root/'js/vendor/primeval'
env=os.environ.copy();env['CARGO_HOME']=str(work/'cargo-home');env['RUSTUP_HOME']=str(work/'rustup-home')
env['PATH']=str(work/'cargo-home/bin')+os.pathsep+env['PATH'];env['CARGO_BUILD_JOBS']='4'
bindgen=next((work/'wasm-bindgen').rglob('wasm-bindgen.exe'))
variant=sys.argv[1] if len(sys.argv)>1 else 'single'
flags='-C target-feature=+simd128';args=[]
if variant=='threaded':
 flags+=' -C target-feature=+atomics,+bulk-memory -C link-arg=--shared-memory -C link-arg=--max-memory=1073741824 -C link-arg=--import-memory -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base'
 args=['-Z','build-std=panic_abort,std'];toolchain='+nightly-2026-10-12';features='asset-triangle,threads'
else:toolchain='+'+os.environ.get('PRIMEVAL_STABLE_TOOLCHAIN','stable');features='asset-triangle'
if variant=='single':
 version=subprocess.check_output([str(work/'cargo-home/bin/rustc.exe'),toolchain,'--version'],env=env,text=True)
 if not version.startswith('rustc 1.99.1 '):raise SystemExit('Use Rust 1.99.1; set PRIMEVAL_STABLE_TOOLCHAIN=1.99.1 when stable points to another version')
env['RUSTFLAGS']=flags;target=work/f'target-site-{variant}'
subprocess.run([str(work/'cargo-home/bin/cargo.exe'),toolchain,'build','--locked','--profile','wasm-release','-p','primeval-wasm','--features',features,'--target','wasm32-unknown-unknown','--target-dir',str(target),*args],cwd=source,env=env,check=True)
output=vendor/'wasm'/variant;output.mkdir(parents=True,exist_ok=True)
subprocess.run([str(bindgen),'--target','web','--no-typescript','--remove-name-section','--out-dir',str(output),'--out-name','primeval',str(target/'wasm32-unknown-unknown/wasm-release/primeval_wasm.wasm')],check=True)
optimizers=list((work/'binaryen').rglob('wasm-opt.exe'))
if optimizers:
 wasm=output/'primeval_bg.wasm';optimized=work/f'site-optimized-{variant}.wasm'
 subprocess.run([str(optimizers[0]),str(wasm),'-O3','--enable-simd','--enable-threads','--enable-bulk-memory','--enable-mutable-globals','--enable-sign-ext','--enable-nontrapping-float-to-int','-o',str(optimized)],check=True)
 shutil.copy2(optimized,wasm)
print('Built',variant,output)
