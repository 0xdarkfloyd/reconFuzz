// Flags: --allow-natives-syntax --experimental-wasm-stringref
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
let tag_index = builder.addTag(makeSig([kWasmStringViewIter], []));

builder.addFunction("test", makeSig([kWasmStringRef], []))
  .addBody([
    kExprLocalGet, 0,
    kGCPrefix, 0xa0, 0x01, // string.as_iter
    kExprThrow, tag_index
  ])
  .exportAs("test");

let instance = builder.instantiate();
try {
  instance.exports.test("hello");
} catch (e) {
  let values = %GetWasmExceptionValues(e);
  let iter = values[0];
  print("Leaked iter: " + iter);
  try {
    %WasmTierUpFunction(iter);
  } catch (e2) {
    print("Caught error in %WasmTierUpFunction: " + e2);
  }
}
