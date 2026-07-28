// Flags: --experimental-wasm-js-interop --experimental-wasm-type-reflection --allow-natives-syntax

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();

let $array_externref =
  builder.addArray(kWasmExternRef, {final: true});
let $array_funcref = builder.addArray(kWasmFuncRef, {final: true});
let $array_i8 = builder.addArray(kWasmI8, {final: true});

let $configureAll = builder.addImport(
  "wasm:js-prototypes", "configureAll",
  makeSig([wasmRefNullType($array_externref),
           wasmRefNullType($array_funcref),
           wasmRefNullType($array_i8), kWasmExternRef], []));

let $imported_func = builder.addImportedGlobal("m", "f", kWasmFuncRef, false);

let $constructors = builder.addImportedGlobal(
  "c", "constructors", kWasmExternRef, false);
let $p1 = builder.addImportedGlobal("c", "p1", kWasmExternRef, false);

// Element segment containing the imported WasmJSFunction.
let func_seg = builder.addPassiveElementSegment(
  [[kExprGlobalGet, $imported_func]], kWasmFuncRef);

let proto_seg = builder.addPassiveElementSegment(
  [[kExprGlobalGet, $p1]], kWasmExternRef);

let data = [
  1,  // number of prototypes
  1,  // has constructor
  1, 97,  // name "a"
  0,  // no statics
  0,  // no methods
  0x7f,  // no parent
];
let data_seg = builder.addPassiveDataSegment(data);

builder.addFunction("test", kSig_v_v).exportFunc().addBody([
  kExprI32Const, 0,
  kExprI32Const, 1,
  kGCPrefix, kExprArrayNewElem, $array_externref, proto_seg,
  kExprI32Const, 0,
  kExprI32Const, 1,
  kGCPrefix, kExprArrayNewElem, $array_funcref, func_seg,
  kExprI32Const, 0,
  kExprI32Const, ...wasmSignedLeb(data.length),
  kGCPrefix, kExprArrayNewData, $array_i8, data_seg,
  kExprGlobalGet, $constructors,
  kExprCallFunction, $configureAll,
]);

// Create a WasmJSFunction that returns an externref.
let wasm_js_func = new WebAssembly.Function(
  {parameters: [], results: ["externref"]},
  () => { return undefined; }
);

let constructors_obj = {};
let imports = {
  m: { f: wasm_js_func },
  c: {
    constructors: constructors_obj,
    p1: { name: "proto1" }
  }
};
let builtins = ["js-prototypes"];
let instance = builder.instantiate(imports, {builtins});

instance.exports.test();

function test_constructor() {
  let x = new constructors_obj.a();
  let count = 0;
  for (let k in x) {
    count++;
  }
  return count;
}

%PrepareFunctionForOptimization(test_constructor);
for (let i = 0; i < 1000; i++) {
  try { test_constructor(); } catch (e) {}
}
%OptimizeMaglevOnNextCall(test_constructor);
try {
  test_constructor();
} catch (e) {
  print("Caught:", e);
}

print("Done");
