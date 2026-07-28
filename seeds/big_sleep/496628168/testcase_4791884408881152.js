d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
const builder = new WasmModuleBuilder();
builder.addFunction('main', kSig_v_v).addBody([kExprNop]).exportAs('main');
const instance = builder.instantiate();
instance.exports.main(); // Trigger compilation
;
%GenerateWasmCompilationHints(instance);