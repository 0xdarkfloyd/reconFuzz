// Flags: --experimental-wasm-growable-stacks --allow-natives-syntax

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

const builder = new WasmModuleBuilder();

const g = builder.addFunction("g", makeSig([], [kWasmI32]))
  .addBody([
    kExprI32Const, 42
  ]);

const f = builder.addFunction("f", makeSig([], [kWasmI32]))
  .addLocals(kWasmI64, 1000); // 8 KB frame

f.addBody([
  kExprReturnCall, g.index
]);

const rec = builder.addFunction("rec", makeSig([kWasmI32], [kWasmI32]))
  .addLocals(kWasmI64, 1000); // 8 KB frame

rec.addBody([
  kExprLocalGet, 0,
  kExprI32Eqz,
  kExprIf, kWasmI32,
    kExprCallFunction, f.index,
  kExprElse,
    kExprLocalGet, 0,
    kExprI32Const, 1,
    kExprI32Sub,
    kExprCallFunction, rec.index,
  kExprEnd
])
.exportFunc();

const instance = builder.instantiate();
const promising_rec = WebAssembly.promising(instance.exports.rec);

async function run() {
  for (let depth = 1; depth < 150; depth++) {
    print("Testing depth:", depth);
    try {
      let val = await promising_rec(depth);
      print("Resolved with:", val);
    } catch (err) {
      print("Rejected with:", err);
    }
  }
}

run();
