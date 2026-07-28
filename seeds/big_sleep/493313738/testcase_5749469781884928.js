d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
const builder = new WasmModuleBuilder();
const sig = makeSig(new Array(100).fill(kWasmI32), [kWasmI32]);
const imp = builder.addImport("m", "f", sig);
builder.addFunction("main", sig)
  .addBody([
    ...new Array(100).fill(0).flatMap((_, i) => [kExprLocalGet, i]),
    kExprCallFunction, imp
  ])
  .exportFunc();
const push = Array.prototype.push;
const instance = builder.instantiate({ m: { f: push } });
function f() {
  try {
    f();
  } catch (e) {
    instance.exports.main(...new Array(100).fill(0));
  }
}
f();
