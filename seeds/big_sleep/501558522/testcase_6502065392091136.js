// Flags: --allow-natives-syntax --no-disallow-unsafe-flags --wasm-generate-compilation-hints --experimental-wasm-compilation-hints

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
builder.addFunction("main", kSig_v_v)
    .addBody([])
    .exportAs("main");

// metadata.code.compilation_priority
let section_name = "metadata.code.compilation_priority";
let section_data = [
    1, // func_count
    0, // func_index
    0, // byte_offset
    2, // hint_length
    0, // compilation_priority
    0  // optimization_priority
];
builder.addCustomSection(section_name, section_data);

let instance = builder.instantiate();

// Wait for Turbofan
let start = Date.now();
while (Date.now() - start < 1000) {
    if (%IsTurboFanFunction(instance.exports.main)) break;
}

print("Is Turbofan: " + %IsTurboFanFunction(instance.exports.main));

print("Calling GenerateWasmCompilationHints...");
%GenerateWasmCompilationHints(instance);
print("Done");
