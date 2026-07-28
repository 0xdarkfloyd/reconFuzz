// Flags: --experimental-wasm-memory-control --allow-natives-syntax

try {
  console.log("WebAssembly.MemoryMapDescriptor: " + WebAssembly.MemoryMapDescriptor);
  let desc = new WebAssembly.MemoryMapDescriptor(1024);
  console.log("Created descriptor: " + desc);
  desc.unmap();
  console.log("Unmapped descriptor");
} catch (e) {
  console.log("Caught: " + e);
  console.log(e.stack);
}
