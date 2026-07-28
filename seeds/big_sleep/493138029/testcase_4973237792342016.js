// Flags: --experimental-wasm-shared --experimental-wasm-custom-descriptors

let bytes = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, // Type section
  0x10, // length
  0x02, // 2 entries
  0x60, 0x00, 0x00, // Type 0: func () -> ()
  0x4e, 0x02,       // Rec group size 2
  0x65, 0x4d, 0x02, 0x5f, 0x00, // Type 1: shared, descriptor 2, struct []
  0x65, 0x4c, 0x01, 0x5f, 0x00, // Type 2: shared, describes 1, struct []
  0x03, // Function section
  0x02, // length
  0x01, // 1 function
  0x00, // func 0 uses type 0
  0x07, // Export section
  0x08, // length
  0x01, // 1 export
  0x04, 0x6d, 0x61, 0x69, 0x6e, // "main"
  0x00, 0x00, // func index 0
  0x0a, // Code section
  0x08, // length
  0x01, // 1 function body
  0x06, // body length
  0x00, // 0 locals
  0xfb, 0x00, 0x02, // struct.new 2
  0x0f, // drop
  0x0b, // end
]);

try {
  let module = new WebAssembly.Module(bytes);
  let instance = new WebAssembly.Instance(module);
  instance.exports.main();
} catch (e) {
}
