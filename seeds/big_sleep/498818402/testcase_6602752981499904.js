// Flags: --experimental-wasm-memory-control --expose-gc

let desc = new WebAssembly.MemoryMapDescriptor(1024);
desc.foo = { a: 42 };

// Verify desc.foo exists
print("Before GC: " + desc.foo.a);

// Trigger GC
gc();

// Access desc.foo
print("After GC: " + desc.foo.a);
