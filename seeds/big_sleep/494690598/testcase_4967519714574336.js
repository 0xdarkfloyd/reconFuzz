// Flags: --experimental-wasm-revectorize --allow-natives-syntax --no-liftoff --no-wasm-tier-up --trace-wasm-revectorize
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
builder.addMemory(1, 1, true);
builder.addFunction("test", kSig_i_iii)
    .addLocals(kWasmS128, 15)
    .addBody([
        // local 10: base = splat(0)
        kExprI32Const, 0,
        0xfd, 0x11,
        kExprLocalSet, 10,

        // local 3: Z = replace_lane(base, 0, 1)
        kExprLocalGet, 10,
        kExprI32Const, 1,
        0xfd, 0x1c, 0,
        kExprLocalSet, 3,

        // local 4: Y = replace_lane(base, 0, 2)
        kExprLocalGet, 10,
        kExprI32Const, 2,
        0xfd, 0x1c, 0,
        kExprLocalSet, 4,

        // local 5: nodes0 = replace_lane(Y, 0, 3)
        kExprLocalGet, 4,
        kExprI32Const, 3,
        0xfd, 0x1c, 0,
        kExprLocalSet, 5,

        // local 6: X = replace_lane(base, 0, 4)
        kExprLocalGet, 10,
        kExprI32Const, 4,
        0xfd, 0x1c, 0,
        kExprLocalSet, 6,

        // local 7: nodes1 = replace_lane(X, 0, 5)
        kExprLocalGet, 6,
        kExprI32Const, 5,
        0xfd, 0x1c, 0,
        kExprLocalSet, 7,

        // local 8: Z_end = replace_lane(nodes1, 0, 6)
        kExprLocalGet, 7,
        kExprI32Const, 6,
        0xfd, 0x1c, 0,
        kExprLocalSet, 8,

        // local 9: A = replace_lane(base, 0, 7)
        kExprLocalGet, 10,
        kExprI32Const, 7,
        0xfd, 0x1c, 0,
        kExprLocalSet, 9,

        // P1 = (Z, Z_end)
        kExprLocalGet, 2,
        kExprLocalGet, 8,
        0xfd, 0x0b, 0, 16,
        kExprLocalGet, 2,
        kExprLocalGet, 3,
        0xfd, 0x0b, 0, 0,

        // P2 = (nodes0, nodes1)
        kExprLocalGet, 1,
        kExprLocalGet, 7,
        0xfd, 0x0b, 0, 16,
        kExprLocalGet, 1,
        kExprLocalGet, 5,
        0xfd, 0x0b, 0, 0,

        // P_aux = (nodes0, A)
        kExprLocalGet, 0,
        kExprLocalGet, 9,
        0xfd, 0x0b, 0, 16,
        kExprLocalGet, 0,
        kExprLocalGet, 5,
        0xfd, 0x0b, 0, 0,

        // Extra pair to increase save
        kExprLocalGet, 0,
        kExprLocalGet, 10,
        0xfd, 0x0b, 0, 48,
        kExprLocalGet, 0,
        kExprLocalGet, 10,
        0xfd, 0x0b, 0, 32,

        kExprI32Const, 1
    ])
    .exportFunc();

let instance = builder.instantiate();
try {
  instance.exports.test(0, 64, 128);
} catch (e) {
  print(e);
}
print("Done");
