d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
let builder = new WasmModuleBuilder();
let kRefSharedExtern = wasmRefType(kWasmExternRef).shared();
let kRefNullSharedExtern = wasmRefNullType(kWasmExternRef).shared();
let substringShared = builder.addImport('wasm:js-string', 'substring', makeSig([kRefNullSharedExtern, kWasmI32, kWasmI32], [kRefSharedExtern]));
builder.addFunction("main", makeSig([kRefNullSharedExtern], [kRefSharedExtern]))
  .addBody([
    kExprLocalGet, 0,
    kExprI32Const, 0,
    kExprI32Const, 1,
    kExprCallFunction, substringShared,
  ])
  .exportFunc();
let instance = builder.instantiate({}, { builtins: ["js-string"] });
  instance.exports.main();