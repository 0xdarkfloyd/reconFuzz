// Flags: --no-disallow-unsafe-flags --wasm-generate-compilation-hints --enable-testing-opcode-in-wasm --allow-natives-syntax --no-wasm-inlining
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
let g = builder.addFunction("g", kSig_v_v).addBody([]);
builder.addFunction("f", kSig_v_v)
    .addBody([
        kExprCallFunction, g.index,
        0x16, // NopForTestingUnsupportedInLiftoff
        kExprCallFunction, g.index,
    ])
    .exportAs("f");

let instance = builder.instantiate();
for (let i = 0; i < 50; i++) {
    instance.exports.f();
}

print("Generating hints...");
%GenerateWasmCompilationHints(instance);
print("Done.");
