d8.file.execute('test/mjsunit/wasm/wasm-module-builder.js');

const builder = new WasmModuleBuilder();
// 16GB is 262144 pages.
let $mem0 = builder.addMemory64(1, 262144);

let main = builder.addFunction('main', kSig_v_v).exportAs('main');
main.addBody([
    ...wasmI64Const(0n), // index
    kSimdPrefix, kExprS128Const, ...new Array(16).fill(0), // value
    kSimdPrefix, 0x54, 0, ...wasmSignedLeb64(9000000000n), 0, // Load8Lane: alignment, offset, lane
    kExprDrop,
  ]);

const instance = builder.instantiate();
try {
    instance.exports.main();
} catch (e) {
    print(e);
}
