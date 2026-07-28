// Flags: --allow-natives-syntax --maglev --turbolev --turbolev-inline-js-wasm-wrappers --turboshaft-wasm-in-js-inlining --trace-turbo-inlining
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

const builder = new WasmModuleBuilder();
const f1 = builder.addFunction('f1', kSig_v_v).addBody([]);
const f2 = builder.addFunction('f2', kSig_v_v).addBody([]);
builder.addDeclarativeElementSegment([f1.index, f2.index]);
builder.addFunction('wasm_warmup', kSig_i_v).addBody([kExprI32Const, 42]).exportFunc();
builder.addFunction('wasm_main', makeSig([kWasmExternRef], [kWasmI32]))
  .addBody([
    kExprLocalGet, 0,
    kExprRefAsNonNull, kExprDrop,
    kExprRefFunc, f2.index, kExprRefIsNull
  ]).exportFunc();

const instance = builder.instantiate();
const wasm_warmup = instance.exports.wasm_warmup;
const wasm_main = instance.exports.wasm_main;

function test(b, arg) {
  if (b) return wasm_warmup();
  return wasm_main(arg);
}
for (let i = 0; i < 20; i++) test(true, null);
try { test(false, null); } catch (e) { console.log("Caught expected trap"); }
console.log("Optimizing");
%OptimizeFunctionOnNextCall(test);
try {
  test();
} catch (e) {
}
console.log("Done");