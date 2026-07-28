// Flags: --experimental-wasm-shared --experimental-wasm-js-interop

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();

// Define a shared struct type
let struct_idx = builder.addStruct({
  fields: [makeField(kWasmI32, true)],
  is_final: true,
  is_shared: true
});

let $array_externref = builder.addArray(kWasmExternRef, { mutable: true, is_final: true });
let $array_funcref = builder.addArray(kWasmFuncRef, { mutable: true, is_final: true });
let $array_i8 = builder.addArray(kWasmI8, { mutable: true, is_final: true });

let $configureAll = builder.addImport(
  "wasm:js-prototypes", "configureAll",
  makeSig([wasmRefNullType($array_externref),
           wasmRefNullType($array_funcref),
           wasmRefNullType($array_i8), kWasmExternRef], []));

let data = [
  1,  // number of prototypes
  0,  // no constructor
  0,  // no methods
  0x7f, // parentidx = -1
];
let data_seg = builder.addPassiveDataSegment(data);

// Function to create the shared struct and return it
builder.addFunction("create_shared_struct", makeSig([], [wasmRefNullType(struct_idx)]))
  .exportFunc()
  .addBody([
    kExprI32Const, 42,
    kGCPrefix, kExprStructNew, struct_idx,
  ]);

// Function to create the array of externref
builder.addFunction("create_array", makeSig([], [wasmRefNullType($array_externref)]))
  .exportFunc()
  .addBody([
    kExprI32Const, 1, // length
    kGCPrefix, kExprArrayNewDefault, $array_externref,
  ]);

// Function to set element in the array
builder.addFunction("set_element", makeSig([wasmRefNullType($array_externref), kWasmI32, kWasmExternRef], []))
  .exportFunc()
  .addBody([
    kExprLocalGet, 0, // array
    kExprLocalGet, 1, // index
    kExprLocalGet, 2, // value
    kGCPrefix, kExprArraySet, $array_externref,
  ]);

// Function to call configureAll with the array
builder.addFunction("test_proto", makeSig([wasmRefNullType($array_externref)], []))
  .exportFunc()
  .addBody([
    // prototypes array: arg 0
    kExprLocalGet, 0,
    
    // functions array: []
    kGCPrefix, kExprArrayNewFixed, $array_funcref, 0,
    
    // data array
    kExprI32Const, 0,
    kExprI32Const, ...wasmSignedLeb(data.length),
    kGCPrefix, kExprArrayNewData, $array_i8, data_seg,
    
    // all_constructors
    kExprRefNull, kExternRefCode,
    
    kExprCallFunction, $configureAll,
  ]);

let builtins = ["js-prototypes"];
let instance = builder.instantiate({}, { builtins });

let shared_obj = instance.exports.create_shared_struct();
let array = instance.exports.create_array();

// Store the shared struct into the array of externref from JS!
instance.exports.set_element(array, 0, shared_obj);

print("Calling test_proto");
try {
  instance.exports.test_proto(array);
  print("No crash");
} catch (e) {
  print("Caught: " + e);
}
