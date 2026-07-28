// Flags: --experimental-wasm-stringref --experimental-wasm-custom-descriptors --no-liftoff
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

const builder = new WasmModuleBuilder();
const struct = builder.addStruct([makeField(kWasmI32, true)]);
const sig_refstruct = builder.addType(makeSig([], [wasmRefType(struct)]));

builder.addFunction('test', makeSig([wasmRefNullType(struct)], [kWasmI32]))
  .addBody([
    kExprBlock, sig_refstruct,
      kExprLocalGet, 0,
      0xfb, 0x19, // br_on_cast_fail
      0x03, // flags: SRC_IS_NULL | RES_IS_NULL
      0x00, // label 0
      struct, // source: struct 0
      0x66, // target: stringview_wtf8
      kExprDrop,
      kExprUnreachable,
    kExprEnd,
    // Stack has (ref struct 0) but it's null!
    kGCPrefix, kExprStructGet, struct, 0,
  ])
  .exportAs('test');

try {
  const instance = builder.instantiate();
  console.log("Instantiated");
  console.log("Calling test(null)...");
  console.log("Result: " + instance.exports.test(null));
} catch (e) {
  console.log("Error: " + e);
}
