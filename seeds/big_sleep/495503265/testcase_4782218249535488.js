// Flags: --no-disallow-unsafe-flags --trace-wasm-generate-compilation-hints --allow-natives-syntax --liftoff --wasm-tier-up --no-wasm-lazy-compilation

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
builder.addFunction("main", kSig_v_v)
    .addBody([kExprNop])
    .exportAs("main");

let instance = builder.instantiate();

print("Triggering tier-up...");
%WasmTriggerTierUpForTesting(instance.exports.main);

print("Waiting for TurboFan...");
let start = Date.now();
while (!%IsTurboFanFunction(instance.exports.main)) {
    if (Date.now() - start > 2000) {
        print("Timeout waiting for tier-up");
        break;
    }
}

if (%IsTurboFanFunction(instance.exports.main)) {
    print("Tier-up complete, calling GenerateWasmCompilationHints...");
    %GenerateWasmCompilationHints(instance);
} else {
    print("Failed to tier up.");
}
