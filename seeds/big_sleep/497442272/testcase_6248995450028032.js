// Flags: --no-disallow-unsafe-flags --trace-wasm-generate-compilation-hints --enable-testing-opcode-in-wasm --allow-natives-syntax
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
builder.addFunction("main", kSig_v_v)
    .addBody([
        0x16 // kExprNopForTestingUnsupportedInLiftoff
    ])
    .exportAs("main");

try {
    let instance = builder.instantiate();
    instance.exports.main();
    %GenerateWasmCompilationHints(instance);
} catch (e) {
    print("Error: " + e);
}
