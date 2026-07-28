// Flags: --no-liftoff --turboshaft-wasm

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

function leb128(v) {
  let res = [];
  do {
    let byte = v & 0x7f;
    v >>= 7;
    if (v !== 0) byte |= 0x80;
    res.push(byte);
  } while (v !== 0);
  return res;
}

let builder = new WasmModuleBuilder();
let numCases = 40000;
let body = [kExprBlock, 0x7f]; // depth 1

body.push(kExprLocalGet, 0);
body.push(kExprIf, 0x40);
  body.push(kExprI32Const, 1);
  body.push(kExprLocalGet, 0);
  body.push(kExprBrTable);
  body.push(...leb128(numCases));
  for (let i = 0; i <= numCases; i++) {
    body.push(...leb128(1)); // jump to outer block
  }
body.push(kExprElse);
  body.push(kExprI32Const, 2);
  body.push(kExprLocalGet, 0);
  body.push(kExprBrTable);
  body.push(...leb128(numCases));
  for (let i = 0; i <= numCases; i++) {
    body.push(...leb128(1)); // jump to outer block
  }
body.push(kExprEnd);

body.push(kExprI32Const, 42);
body.push(kExprEnd);

builder.addFunction("test", makeSig([kWasmI32], [kWasmI32]))
  .addBody(body).exportFunc();

try {
  let instance = builder.instantiate();
  print('Instantiated');
  print(instance.exports.test(0));
} catch (e) {
  print('Caught: ' + e);
}
