// Flags: --experimental-wasm-wasmfx --wasm-generate-compilation-hints --no-disallow-unsafe-flags

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

const builder = new WasmModuleBuilder();
const sig_v_v = builder.addType(kSig_v_v);
const cont_idx = builder.addCont(sig_v_v);
const func0 = builder.addFunction("func0", kSig_v_v).addBody([]);
builder.addDeclarativeElementSegment([func0.index]);
builder.addFunction("main", kSig_v_v)
    .addBody([
        kExprCallFunction, func0.index,
        kExprCallFunction, func0.index,
        kExprRefFunc, func0.index,
        0xe0, cont_idx, // cont.new
        kExprDrop,
        kExprCallFunction, func0.index,
    ])
    .exportAs("main");

const instance = builder.instantiate();
print("Calling main...");
try {
    instance.exports.main();
} catch (e) {
    print("Caught in main: " + e);
}
print("Generating compilation hints...");
%GenerateWasmCompilationHints(instance);
print("Done.");
