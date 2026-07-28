// Flags: --allow-natives-syntax --experimental-wasm-growable-stacks --expose-gc

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

const builder = new WasmModuleBuilder();

// Define a signature for multi-value returns (10 i64s)
// First few are returned in registers, the rest are returned on the stack
const sig_multi_i64 = makeSig([], [
  kWasmI64, kWasmI64, kWasmI64, kWasmI64, kWasmI64,
  kWasmI64, kWasmI64, kWasmI64, kWasmI64, kWasmI64
]);

const sig_multi_i64_index = builder.addType(sig_multi_i64);

// Signature for the consume function (takes depth, returns 10 i64s)
const sig_consume = makeSig([kWasmI32], [
  kWasmI64, kWasmI64, kWasmI64, kWasmI64, kWasmI64,
  kWasmI64, kWasmI64, kWasmI64, kWasmI64, kWasmI64
]);

// Function B: returns 10 distinct constants
const b = builder.addFunction("b", sig_multi_i64)
  .addBody([
    kExprI64Const, 10,
    kExprI64Const, 20,
    kExprI64Const, 30,
    kExprI64Const, 40,
    kExprI64Const, 50,
    kExprI64Const, 60,
    kExprI64Const, 70,
    kExprI64Const, 80,
    kExprI64Const, 90,
    kExprI64Const, 100
  ]);

// Function A: has a large frame (1000 locals) and tail-calls B
const a = builder.addFunction("a", sig_multi_i64)
  .addLocals(kWasmI64, 1000)
  .addBody([
    kExprReturnCall, b.index
  ]);

// Function consume: recursive function with large frame to fill stack
const consume = builder.addFunction("consume", sig_consume)
  .addLocals(kWasmI64, 1000); // 1000 locals = 8KB frame

consume.addBody([
  kExprLocalGet, 0,
  kExprI32Const, 0,
  kExprI32Ne,
  kExprIf, sig_multi_i64_index,
    kExprLocalGet, 0,
    kExprI32Const, 1,
    kExprI32Sub,
    kExprCallFunction, consume.index,
  kExprElse,
    kExprCallFunction, a.index,
  kExprEnd
]);

// Main caller function
const caller = builder.addFunction("caller", sig_consume)
  .addBody([
    kExprLocalGet, 0,
    kExprCallFunction, consume.index,
  ]).exportFunc();

const instance = builder.instantiate();
const wrapper = WebAssembly.promising(instance.exports.caller);

// Run with depth 2 to trigger stack growth on A, followed by tail-call return slot corruption
wrapper(2);
