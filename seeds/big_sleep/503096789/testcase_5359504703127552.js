d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
const builder = new WasmModuleBuilder();
const sig_v_v = builder.addType(makeSig([], []));
const sig_i_v = builder.addType(makeSig([kWasmI32], []));
const cont_v_v = builder.addCont(sig_v_v);
const cont_i_v = builder.addCont(sig_i_v);
const tag = builder.addTag(makeSig([], []));
const f2 = builder.addFunction("f2", sig_v_v)
  .addBody([
    kExprSuspend, tag,
  ]);
builder.addDeclarativeElementSegment([f2.index]);
const f_with_resume = builder.addFunction("f_with_resume", sig_v_v);
f_with_resume.addBody([
    kExprBlock, builder.addType(makeSig([], [wasmRefNullType(cont_v_v)])),
        kExprRefFunc, f2.index,
        kExprContNew, cont_v_v,
        kExprResume, cont_v_v, // kOnSuspend
          0, // br to block
        kExprRefNull, cont_v_v,
    kExprEnd,
    kExprDrop,
]);
const grow = builder.addFunction("grow", sig_i_v);
grow.addBody([
    kExprLocalGet, 0,
    kExprI32Eqz,
    kExprIf, kWasmVoid,
      kExprCallFunction, f_with_resume.index,
    kExprElse,
      kExprLocalGet, 0,
      kExprI32Const, 1,
      kExprI32Sub,
      kExprCallFunction, grow.index,
    kExprEnd
  ]);
const f1 = builder.addFunction("f1", sig_i_v)
  .addBody([
    kExprLocalGet, 0,
    kExprCallFunction, grow.index,
  ]);
builder.addDeclarativeElementSegment([f1.index]);
builder.addFunction("starter", sig_i_v)
  .addBody([
    kExprLocalGet, 0,
    kExprRefFunc, f1.index,
    kExprContNew, cont_i_v,
    kExprContBind, cont_i_v, cont_v_v,
    kExprResume, cont_v_v, 0,
  ]).exportFunc();
const instance = builder.instantiate();
for (let i = 1; i < 100; i++) {
  try {
    instance.exports.starter(i);
  } catch (e) {
  }
}