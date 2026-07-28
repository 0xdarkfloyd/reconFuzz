d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();
builder.addImport("m", "throw", makeSig([], []));
builder.addFunction("crash", makeSig([], []))
    .addBody([
        kExprBlock, 0x69, // kWasmExnRef
            kExprTryTable, kWasmVoid, 1,
                kCatchAllRef, 0,
                kExprCallFunction, 0,
            kExprEnd,
            kExprReturn,
        kExprEnd,
        kExprRefAsNonNull,
        kExprDrop,
    ])
    .exportAs("crash");

    let instance = builder.instantiate({m: {throw: () => { throw 42; }}});
    instance.exports.crash();
