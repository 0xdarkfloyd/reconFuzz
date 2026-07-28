d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
let builder = new WasmModuleBuilder();
let wq_type = wasmRefType(kWasmWaitqueueRef).shared();
builder.addGlobal(wq_type, true, false, [kAtomicPrefix, kExprWaitqueueNew]);
builder.addExportOfKind("g", kExternalGlobal, 0);
let instance = builder.instantiate();
instance.exports.g.value;