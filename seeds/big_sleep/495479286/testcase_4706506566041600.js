// Flags: --allow-natives-syntax --experimental-wasm-stringref
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
let tag_idx = builder.addTag(makeSig([-26], []));

builder.addFunction("test", makeSig([kWasmStringRef], []))
  .addBody([
    kExprLocalGet, 0,
    0xfb, 0x90, 0x01, // string.as_wtf8
    kExprThrow, tag_idx,
  ])
  .exportFunc();

let instance = builder.instantiate();
try {
  instance.exports.test("hello");
} catch (e) {
  let values = %GetWasmExceptionValues(e);
  let view = values[0];
  console.log("Leaked view");
  
  try {
    Array.prototype.reverse.call(view);
  } catch (err) { console.log("Reverse error: " + err); }
}
