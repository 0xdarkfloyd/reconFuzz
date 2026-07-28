
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

function makeModule() {
    let builder = new WasmModuleBuilder();
    for (let i = 0; i < 100; i++) {
        builder.addFunction("f" + i, kSig_i_i)
            .addBody([kExprLocalGet, 0])
            .exportFunc();
    }
    return new WebAssembly.Module(builder.toBuffer());
}

let module = makeModule();

let worker = new Worker(`
    onmessage = function(module) {
        while (true) {
            %FlushLiftoffCode();
            %WasmTriggerCodeGC();
        }
    };
`, {type: 'string'});

worker.postMessage(module);

for (let j = 0; j < 100; j++) {
    let instance = new WebAssembly.Instance(module);
    for (let i = 0; i < 100; i++) {
        try {
            instance.exports["f" + i](i);
        } catch (e) {}
    }
    if (j % 10 == 0) gc();
}
print("Done");
