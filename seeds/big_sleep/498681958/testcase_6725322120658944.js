// Flags: --sandbox-testing --turbolev --turbolev-inline-js-wasm-wrappers --allow-natives-syntax

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();

// W1 expects 20 Float64 arguments
let sig1 = builder.addType(makeSig(Array(20).fill(kWasmF64), []));
builder.addFunction("w1", sig1)
    .addBody([
        kExprNop
    ])
    .exportAs("w1");

// W2 expects 0 arguments
let sig2 = builder.addType(makeSig([], []));
builder.addFunction("w2", sig2)
    .addBody([
        kExprNop
    ])
    .exportAs("w2");

let instance = builder.instantiate();
let f1 = instance.exports.w1;
let f2 = instance.exports.w2;

let buffer = new Sandbox.MemoryView(0, 0x100000000);
let memory = new DataView(buffer);

let addr1 = Sandbox.getAddressOf(f1);
let addr2 = Sandbox.getAddressOf(f2);

let sfi1 = memory.getUint32(addr1 + 16, true) - 1;
let sfi2 = memory.getUint32(addr2 + 16, true) - 1;

let data1 = memory.getUint32(sfi1 + 4, true);

function caller() {
    return f2();
}

%PrepareFunctionForOptimization(caller);
caller();

// Corrupt to data1
memory.setUint32(sfi2 + 4, data1, true);

// Optimize
%OptimizeFunctionOnNextCall(caller);

try { caller(); } catch (e) {}

console.log("Finished");
