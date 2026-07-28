// Flags: --allow-natives-syntax --no-disallow-unsafe-flags --trace-wasm-generate-compilation-hints --wasm-eager-tier-up-function=0

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

const builder = new WasmModuleBuilder();
builder.addFunction('main', kSig_v_v).addBody([kExprNop]).exportAs('main');

const instance = builder.instantiate();

console.log("Generating hints...");
%GenerateWasmCompilationHints(instance);
console.log("Done.");
