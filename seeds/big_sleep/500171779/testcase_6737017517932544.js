d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
let builder = new WasmModuleBuilder();
let i8_arr_idx = builder.addArray(kWasmI8);
let externref_arr_idx = builder.addArray(kWasmExternRef);
let funcref_arr_idx = builder.addArray(kWasmFuncRef);
builder.addFunction("create_i8_arr", makeSig([kWasmI32], [wasmRefType(i8_arr_idx)]))
  .addBody([
     0,
  ]).exportFunc();
builder.addFunction("create_externref_arr", makeSig([kWasmI32], [wasmRefType(externref_arr_idx)]))
  .addBody([
     0,
  ]).exportFunc();
builder.addFunction("create_funcref_arr", makeSig([kWasmI32], [wasmRefType(funcref_arr_idx)]))
  .addBody([
    kExprLocalGet, 0,
    kGCPrefix, kExprArrayNewDefault, funcref_arr_idx
  ]).exportFunc();
let dummy_func_idx = builder.addFunction("dummy", makeSig([], []))
  .addBody([]).exportFunc().index;
builder.addFunction("fill_funcref_arr", makeSig([wasmRefType(funcref_arr_idx)], []))
  .addLocals(kWasmI32, 1)
  .addBody([
    kExprLoop, kWasmVoid,
      kExprLocalGet, 1,
      kExprBrIf, 1,
    kExprEnd,
  ]).exportFunc();
builder.addFunction("fill_i8_arr", makeSig([wasmRefType(i8_arr_idx), kWasmI32, kWasmI32], []))
  .addLocals(kWasmI32, 3) // offset, p, i
  .addBody([
    kExprLoop, kWasmVoid, i8_arr_idx,
      kExprLoop, kWasmVoid,
        kExprLocalGet, 5,
        kExprLocalGet, 2,
        kExprI32GeU,
        kExprBrIf, 1,
      kExprEnd,
    kExprEnd,
  ]).exportFunc();
let instance = builder.instantiate();
let funcref_arr = instance.exports.create_funcref_arr();
instance.exports.fill_funcref_arr(funcref_arr);