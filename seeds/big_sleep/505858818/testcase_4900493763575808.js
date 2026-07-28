d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
builder.addFunction("test", kSig_v_v)
    .addBody([0x16]) // NopForTestingUnsupportedInLiftoff
    .exportFunc();
try {
    let instance = builder.instantiate();
    instance.exports.test();
} catch (e) {
}
