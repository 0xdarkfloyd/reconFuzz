// Flags: --experimental-wasm-wasmfx --no-liftoff

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

const builder = new WasmModuleBuilder();
const sig_index = builder.addType(makeSig([], [kWasmI32]));
const cont_index = builder.addCont(sig_index);
const P = 127;
const tag_sig = builder.addType(makeSig(new Array(P).fill(kWasmAnyRef), []));
const tag_index = builder.addTag(tag_sig);
const block_sig = builder.addType(makeSig([], [...new Array(P).fill(kWasmAnyRef), wasmRefType(cont_index)]));

let body = [];
body.push(kExprBlock, ...wasmSignedLeb(block_sig));
  body.push(kExprRefNull, cont_index);
  body.push(0xe3, ...wasmUnsignedLeb(cont_index));
  body.push(1, 0, ...wasmUnsignedLeb(tag_index), 0);
  body.push(kExprDrop, kExprUnreachable);
body.push(kExprEnd);
body.push(kExprDrop); // drop cont
body.push(kExprRefIsNull);
body.push(kExprDrop);
for (let i = 0; i < P - 1; i++) body.push(kExprDrop);

builder.addFunction("test", makeSig([], []))
  .addBody(body)
  .exportFunc();

const instance = builder.instantiate();
try {
  instance.exports.test();
} catch (e) {}
