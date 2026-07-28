// Flags: --allow-natives-syntax --wasm-generate-compilation-hints --no-disallow-unsafe-flags

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
builder.addFunction("main", kSig_v_v)
    .addBody([kExprNop])
    .exportAs("main");

let instance = builder.instantiate();

print("Tiering up...");
%WasmTriggerTierUpForTesting(instance.exports.main);

let count = 0;
while (!%IsTurboFanFunction(instance.exports.main) && count < 1000000) {
    count++;
}

if (%IsTurboFanFunction(instance.exports.main)) {
    print("Tiered up to TurboFan! Calling GenerateWasmCompilationHints...");
    %GenerateWasmCompilationHints(instance);
    print("Success!");
} else {
    print("Failed to tier up.");
}
