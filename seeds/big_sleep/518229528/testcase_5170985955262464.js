d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
let builder = new WasmModuleBuilder();
let shared_eqref = { opcode: 99, heap_type: -19, is_shared: true };

let struct_idx = builder.addStruct({
  fields: [
    makeField(kWasmI32, true),
    makeField(kWasmI64, true),
    makeField(shared_eqref, true)
  ],
  shared: true
});
let struct_ref = wasmRefType(struct_idx);
builder.addFunction("run_test", makeSig([], [kWasmI32]))
  .addLocals(struct_ref, 3) // s1, s2, parent
  .addBody([
    kExprI32Const, 1,
    kExprI64Const, 10,
    kExprRefNull, 0x65, 0x6d, // shared eqref
    kGCPrefix, kExprStructNew, ...wasmUnsignedLeb(struct_idx),
    kExprLocalSet, 0,
    kExprI32Const, 2,
    kExprI64Const, 20,
    kExprRefNull, 0x65, 0x6d, // shared eqref
    kGCPrefix, kExprStructNew, ...wasmUnsignedLeb(struct_idx),
    kExprLocalSet, 1,
    kExprI32Const, 0,
    kExprI64Const, 0,
    kExprLocalGet, 0, // s1
    kGCPrefix, kExprStructNew, ...wasmUnsignedLeb(struct_idx),
    kExprLocalSet, 2,
    kExprLocalGet, 2, // parent
    kAtomicPrefix, 0x5c, 0, ...wasmUnsignedLeb(struct_idx), 2, // struct.atomic.get
     0, // s1
    kExprRefEq,
    kExprIf, kWasmI32,
      kExprLocalGet, 2, // parent
       0, // s1
      
      kExprIf, kWasmI32,
        kExprLocalGet, 2, // parent
        kExprLocalGet, 1, // s2
        kExprRefEq,
        kExprIf, kWasmI32,
          kExprLocalGet, 2, // parent
          kExprLocalGet, 1, // s2 (expected)
          kExprRefEq,
          kExprIf, kWasmI32,
             0, // s1
          kExprElse, 0,
          kExprEnd,
        kExprElse,
           0,
        kExprEnd,
      kExprElse,
         0,
      kExprEnd,
    kExprElse, 0,
    kExprEnd,
  ]).exportFunc();
let instance = builder.instantiate();
 instance.exports.run_test();