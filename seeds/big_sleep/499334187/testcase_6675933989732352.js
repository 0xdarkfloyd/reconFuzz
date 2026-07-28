// Flags: --experimental-wasm-shared --allow-natives-syntax --no-liftoff

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
let kRefNullSharedExtern = wasmRefNullType(kWasmExternRef).shared();
let kRefSharedExtern = wasmRefType(kWasmExternRef).shared();

let concat = builder.addImport('wasm:js-string', 'concat', makeSig([kRefNullSharedExtern, kRefNullSharedExtern], [kRefSharedExtern]));

builder.addFunction('test', makeSig([kRefNullSharedExtern, kRefNullSharedExtern], []))
  .addBody([
    kExprLocalGet, 0,
    kExprLocalGet, 1,
    kExprCallFunction, concat,
    kExprDrop
  ])
  .exportFunc();

let instance = builder.instantiate({}, { builtins: ['js-string'] });
print("Calling concat...");
instance.exports.test(null, null);
print("Done");
