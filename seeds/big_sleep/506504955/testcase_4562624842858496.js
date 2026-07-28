// Flags: --experimental-wasm-memory-control --allow-natives-syntax

const descriptor = new WebAssembly.MemoryMapDescriptor(1024);

function crash() {
  return descriptor;
}

%PrepareFunctionForOptimization(crash);
crash();
crash();
%OptimizeFunctionOnNextCall(crash);
crash();
