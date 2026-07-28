d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
const builder = new WasmModuleBuilder();
builder.addFunction("main", kSig_i_v).addBody([kExprI32Const, 42]).exportAs("main");
const instance = builder.instantiate();
console.log("Done");
