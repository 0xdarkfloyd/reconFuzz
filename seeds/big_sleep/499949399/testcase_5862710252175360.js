d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
let builder = new WasmModuleBuilder();
let types = [ kWasmExternRef, kWasmExternRef, kWasmI32, kWasmI32, kWasmExternRef];
builder.addFunction("wasm_func", makeSig(types, [kWasmI32]))
  .addBody([kExprLocalGet, 3]) // Just return something
  .exportAs("wasm_func");
let instance = builder.instantiate();
let wasm_func = instance.exports.wasm_func;
function F0() {
}
function wrapper() {
  return F0();
}
%PrepareFunctionForOptimization();
for (let i = 0; i < 1000; i++) wrapper();
let buffer = new Sandbox.MemoryView(0, 0x100000000);
let memory = new DataView(buffer);

let wasm_func_addr = Sandbox.getAddressOf(wasm_func);
let wasm_sfi_addr = memory.getUint32(wasm_func_addr + 16, true) - 1;
let f0_addr = Sandbox.getAddressOf(F0);
let f0_sfi_addr = memory.getUint32(f0_addr + 16, true) - 1;

for (let i = 4; i < 40; i += 4) {
    let val = memory.getUint32(wasm_sfi_addr + i, true);
    memory.setUint32(f0_sfi_addr + i, val, true);
}
%OptimizeFunctionOnNextCall(wrapper);
wrapper();