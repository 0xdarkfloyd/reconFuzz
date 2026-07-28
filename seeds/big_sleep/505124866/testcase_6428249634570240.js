d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
const builder = new WasmModuleBuilder();
builder.addFunction("test", kSig_v_v)
  .addBody([
    kExprF32Const, 0, 0, 0, 0,
    kSimdPrefix, 0xa0, 0x02,
    kExprF32Const, 0, 0, 0, 0,
    kSimdPrefix, 0xa0, 0x02,
    kSimdPrefix, 0xae, 0x01,
    kExprF32Const, 0, 0, 0, 0,
    kSimdPrefix, 0xa0, 0x02,
    kExprF32Const, 0, 0, 0, 0,
    kSimdPrefix, 0xa0, 0x02,
    kSimdPrefix, 0xae, 0x01,
    kSimdPrefix, 0xae, 0x01,
    kExprDrop
  ])
  .exportAs("test");
const instance = builder.instantiate();
    instance.exports.test();