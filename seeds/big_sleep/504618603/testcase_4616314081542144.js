// Flags: --turboshaft-wasm --no-liftoff --sim-arm64-optional-features=mops

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
builder.addMemory(1, 1, false);
builder.exportMemoryAs('memory');

builder.addFunction('test', makeSig([kWasmI32, kWasmI32, kWasmI32], [kWasmI32]))
    .addBody([
        kExprLocalGet, 0,
        kExprLocalGet, 1,
        kExprLocalGet, 2,
        kNumericPrefix, kExprMemoryCopy, 0, 0,
        kExprLocalGet, 0,
        kExprI32Load, 0, 0,
    ])
    .exportFunc();

const instance = builder.instantiate();
const mem = new Uint32Array(instance.exports.memory.buffer);
mem[0] = 111;
mem[1] = 222;
mem[10] = 333; // 10*4 = 40

for (let i = 0; i < 1000; i++) {
    instance.exports.test(0, 0, 0);
}

let res = instance.exports.test(0, 40, 4);
print("Result (should be 333 if correct, or something else if clobbered): " + res);
