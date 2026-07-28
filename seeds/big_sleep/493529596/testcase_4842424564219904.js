// Flags: --experimental-wasm-wasmfx --allow-natives-syntax --no-liftoff

d8.file.execute('test/mjsunit/wasm/wasm-module-builder.js');

const builder = new WasmModuleBuilder();
const sig0 = builder.addType(kSig_v_v);
const cont1 = builder.addCont(0);
const sig2 = builder.addType(makeSig([wasmRefType(1)], []));
const cont3 = builder.addCont(2);
const tag0 = builder.addTag(0);

const dummy = builder.addFunction('dummy', 2).addBody([]).exportFunc();
const inner = builder.addFunction('inner', 0).addBody([
    kExprRefFunc, 1, kExprContNew, 1,
    kExprRefFunc, 0, kExprContNew, 3,
    kExprSwitch, 3, 0,
    kExprDrop
]).exportFunc();

builder.addDeclarativeElementSegment([0, 1]);

let instance = builder.instantiate();
try {
    instance.exports.inner();
} catch (e) {
    print("Caught: " + e);
}
