// Flags: --no-disallow-unsafe-flags --trace-wasm-generate-compilation-hints --allow-natives-syntax --experimental-wasm-compilation-hints

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
let f = builder.addFunction("main", kSig_v_v)
    .addBody([
        kExprNop
    ])
    .exportAs("main");

// Set compilation priority for main (index 0)
builder.setCompilationPriority(0, 1, 1);

let instance = builder.instantiate();
let main = instance.exports.main;

print("Is Turbofan: " + %IsTurboFanFunction(main));

// Wait for background compilation to finish.
let count = 0;
while (!%IsTurboFanFunction(main) && count < 1000000) {
    count++;
}

print("Is Turbofan: " + %IsTurboFanFunction(main));

if (%IsTurboFanFunction(main)) {
    print("Calling GenerateWasmCompilationHints...");
    %GenerateWasmCompilationHints(instance);
} else {
    print("Did not tier up.");
}
