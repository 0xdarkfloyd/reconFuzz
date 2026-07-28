d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");
 {
  let b = new WasmModuleBuilder();
  let sig_i_e = b.addType(makeSig([kWasmI32], [kWasmExternRef]));
  let array_type = b.addArray(kWasmExternRef, {mutable: true});
  let sig_i_a = b.addType(makeSig([kWasmI32], [wasmRefType(array_type)]));
  
  b.addImport("wasm:js-string", "fromCharCode", sig_i_e);
  b.addFunction("test", sig_i_a)
    .addBody([
      ...wasmI32Const(1),
      kGCPrefix, kExprArrayNewDefault, array_type,
      kExprLocalTee, 1,
      kExprI32Const, 0,
      kExprLocalGet, 0,
      kExprCallFunction, 0,
      kGCPrefix, kExprArraySet, array_type,
      kExprLocalGet, 1,
    ])
    .addLocals(wasmRefType(array_type), 1)
    .exportFunc();
  let bytes = Array.from(b.toBuffer());
  function replaceAll(arr, oldS, newS) {
    let count = 0;
    for (let i = 0; i <= arr.length - oldS.length; i++) {
      let match = true;
      for (let j = 0; j < oldS.length; j++) if (arr[i+j] !== oldS[j]) { match = false; break; }
      if (match) { arr.splice(i, oldS.length, ...newS); i += newS.length - 1; count++; }
    }
  }
  replaceAll(bytes, [0x60, 0x01, 0x7f, 0x01, 0x6f], [0x60, 0x01, 0x7f, 0x01, 0x64, 0x65, 0x6f]);
  replaceAll(bytes, [0x5e, 0x6f, 0x01], [0x65, 0x5e, 0x63, 0x65, 0x6f, 0x01]);
  for (let i = 8; i < bytes.length; i++) { if (bytes[i] === 0x01) { bytes[i+1] += 5; break; } }
  let module = new WebAssembly.Module(new Uint8Array(bytes), { builtins: ["js-string"] });
  let instance = new WebAssembly.Instance(module, {});
  instance.exports.test(0x100);
}
