// Flags: --no-disallow-unsafe-flags --trace-wasm-generate-compilation-hints --no-wasm-dynamic-tiering --allow-natives-syntax

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
builder.addFunction("main", kSig_v_v)
    .addBody([kExprNop])
    .exportAs("main");

let instance = builder.instantiate();
%WasmTierUpFunction(instance.exports.main);

%GenerateWasmCompilationHints(instance);
