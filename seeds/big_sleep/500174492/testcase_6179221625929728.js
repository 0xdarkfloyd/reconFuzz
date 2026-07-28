// Flags: --experimental-wasm-custom-descriptors --experimental-wasm-shared

let payload = [
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
];

// Type section
let type_content = [
  0x01, // Count 1 rec group
  0x4e, // kWasmRecursiveTypeGroupCode
  0x02, // Group size 2
  
  // Type 0: Shared Struct with Descriptor 1
  0x65, // Shared
  0x4d, // Descriptor (0x4d)
  0x01, // descriptor index 1
  0x5f, // Struct
  0x00, // 0 fields
  
  // Type 1: Shared Descriptor Struct describing 0
  0x65, // Shared
  0x4c, // Describes (0x4c)
  0x00, // describes index 0
  0x5f, // Struct
  0x00  // 0 fields
];

let size = type_content.length;
payload.push(0x01); // ID
payload.push(size);
payload.push(...type_content);

// Table section: 1 table of (ref null 1)
payload.push(0x04, 0x05, 0x01, 0x63, 0x01, 0x00, 0x0a);

// Element section
let element_content = [
  0x01, // Count
  0x06, // Flags: active, table, offset, expressions
  0x00, // Table index 0
  0x41, 0x00, 0x0b, // offset: i32.const 0, end
  0x63, 0x01, // element type: (ref null 1)
  0x01, // Count 1
  0xfb, 0x01, 0x01, // struct.new_default 1
  0x0b  // kExprEnd
];

payload.push(0x09); // ID
payload.push(element_content.length);
payload.push(...element_content);

try {
  let module = new WebAssembly.Module(new Uint8Array(payload));
  console.log("Module compiled!");
  let instance = new WebAssembly.Instance(module);
  console.log("Module instantiated!");
} catch (e) {
  console.log("Error: " + e);
}
