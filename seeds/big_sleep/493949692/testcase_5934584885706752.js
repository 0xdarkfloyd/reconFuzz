d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
let builder = new WasmModuleBuilder();
let struct_idx = builder.addStruct([{type: kWasmWaitQueue, mutability: true}]);
builder.addFunction("create", makeSig([], [wasmRefType(struct_idx)]))
    .addBody([kExprI32Const, 0, kGCPrefix, kExprStructNew, struct_idx])
    .exportFunc();
let module_bytes = builder.toBuffer();
let worker_script = `
    onmessage = function(event) {
        try {
            let {module_bytes} = event.data;
            let module = new WebAssembly.Module(module_bytes);
            let instance = new WebAssembly.Instance(module);
            let struct = instance.exports.create();
        } catch (e) {
        }
    };
`;
for (let i = 0; i < 50; i++) {
    let worker = new Worker(worker_script, {type: 'string'});
    worker.postMessage({module_bytes});
}