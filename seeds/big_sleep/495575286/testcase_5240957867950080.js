// Flags: --allow-natives-syntax --experimental-wasm-stringref
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
let tag_index = builder.addTag(makeSig([kWasmStringViewWtf8], []));

builder.addFunction("make_and_throw", makeSig([kWasmStringRef], []))
    .addBody([
        kExprLocalGet, 0,
        kGCPrefix, 0x90, 0x01,
        kExprThrow, tag_index
    ])
    .exportFunc();

let instance = builder.instantiate();
try {
    instance.exports.make_and_throw("hello");
} catch (e) {
    let values = %GetWasmExceptionValues(e);
    let view = values[0];
    print("Got view");
    let m = new Map();
    m.set(view, 1);
    print("Map set succeeded");
}
