d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
let builder = new WasmModuleBuilder();
let kSharedRefString = wasmRefType(kWasmStringRef).shared();
let struct = builder.addStruct({fields: [makeField(kSharedRefString, true)], shared: true});
builder.addFunction("put_in_struct", makeSig([kSharedRefString], [wasmRefType(struct)]))
  .addBody([
    kExprLocalGet, 0,
    kGCPrefix, kExprStructNew, struct
  ])
  .exportFunc();
  let instance = builder.instantiate();
  let s = "A".repeat() + Math.random();
  let st = instance.exports.put_in_struct(s);