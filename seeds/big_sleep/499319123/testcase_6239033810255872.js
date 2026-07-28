// Flags: --no-disallow-unsafe-flags --wasm-generate-compilation-hints --wasm-eager-tier-up-function=0 --no-wasm-lazy-compilation --allow-natives-syntax
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
let builder = new WasmModuleBuilder();
builder.addFunction("main", kSig_i_v).addBody([kExprI32Const, 42]).exportAs("main");
let instance = builder.instantiate();
%GenerateWasmCompilationHints(instance);
