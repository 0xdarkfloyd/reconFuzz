d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
const builder = new WasmModuleBuilder();
const array_type = builder.addArray(kWasmI32);

builder.addFunction("main", makeSig([], []))
  .addBody([
    kExprI32Const, 0, // offset
    kExprI32Const, 0, // length
    kGCPrefix, kExprArrayNewData, array_type, 0, // array.new_data array_type 0
    kExprDrop
  ])
const origBytes = Array.from(builder.toBuffer());
function addDataCountSection(bytes) {
  let res = [];
  res.push(...bytes.slice(0, 8)); // header
  let i = 8;
  while (i < bytes.length) {
    let section_id = bytes[i];
    if (section_id === 10) { // Code section
      res.push(12, 1, 1); // Insert DataCount section (ID 12) with 1 segment
      res.push(...bytes.slice(i));
      return new Uint8Array(res);
    }
    res.push(bytes[i]); // section ID
    let len = bytes[i+1];
    res.push(...bytes.slice(i+1, i+2+len));
    i += 2 + len;
  }
bytes;
}

const moduleBytes = addDataCountSection(origBytes);

WebAssembly.compile(moduleBytes).then(

);