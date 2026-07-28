d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
let builder = new WasmModuleBuilder();
let array_extern = builder.addArray(kWasmExternRef, {final: true});
let array_func = builder.addArray(kWasmFuncRef, {final: true});
let array_i8 = builder.addArray(kWasmI8, {final: true});
let data_bytes = [
    2, // num_prototypes
    1, // has_constructor
    1, // name_length
    65, // 'A'
    0, // num_statics
    0, // num_methods
    127, // parent_idx = -1
    0, // has_constructor
    0, // num_methods
    0  // parent_idx = 0
];
let data_segment = builder.addPassiveDataSegment(data_bytes);
let configureAll = builder.addImport(
    'wasm:js-prototypes', 'configureAll',
    makeSig([
        wasmRefNullType(array_extern),
        wasmRefNullType(array_func),
        wasmRefNullType(array_i8),
        kWasmExternRef
    ], [])
);
builder.addFunction('test', makeSig([
    wasmRefNullType(array_extern),
    wasmRefNullType(array_func),
    wasmRefNullType(array_i8),
    kWasmExternRef
], []))
.addBody([
    kExprLocalGet, 0,
    kExprLocalGet, 1,
    kExprLocalGet, 2,
    kExprLocalGet, 3,
    kExprCallFunction, configureAll
])
.exportFunc();
builder.addFunction('create_prototypes_array', makeSig([kWasmExternRef, kWasmExternRef], [wasmRefType(array_extern)]))
.addBody([
    kExprLocalGet, 0,
    kExprLocalGet, 1,
    kGCPrefix, kExprArrayNewFixed, array_extern, 2
])
.exportFunc();
builder.addFunction('create_functions_array', makeSig([kWasmFuncRef], [wasmRefType(array_func)]))
.addBody([
    kExprLocalGet, 0,
    kGCPrefix, kExprArrayNewFixed, array_func, 1
])
.exportFunc();
builder.addFunction('create_data_array', makeSig([], [wasmRefType(array_i8)]))
.addBody([
    kExprI32Const, 0,
    kExprI32Const, data_bytes.length,
    kGCPrefix, kExprArrayNewData, array_i8, data_segment
])
.exportFunc();
builder.addFunction('set_prototypes_array', makeSig([wasmRefType(array_extern), kWasmI32, kWasmExternRef], []))
.addBody([
    kExprLocalGet, 0,
    kExprLocalGet, 1,
    kExprLocalGet, 2,
    kGCPrefix, kExprArraySet, array_extern
])
.exportFunc();
let instance = builder.instantiate({}, { builtins: ["js-prototypes"] });
let proxy1 = new Proxy({}, {
    defineProperty() {
        instance.exports.set_prototypes_array(prototypes_array);
        return true;
    }
});
let proxy2 = new Proxy({}, {});
let prototypes_array = instance.exports.create_prototypes_array(proxy1, proxy2);
let functions_array = instance.exports.create_functions_array(instance.exports.test);
let data_array = instance.exports.create_data_array();
let constructors = {};
    instance.exports.test(prototypes_array, functions_array, data_array, constructors);