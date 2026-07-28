// Flags: --experimental-wasm-custom-descriptors --experimental-wasm-js-interop --allow-natives-syntax

d8.file.execute("test/mjsunit/wasm/wasm-module-builder.js");

let builder = new WasmModuleBuilder();

builder.startRecGroup();
let $desc0 = builder.nextTypeIndex() + 1;
let $struct0 = builder.addStruct({descriptor: $desc0});
/* $desc0 */ builder.addStruct({fields: [makeField(kWasmExternRef, false)], describes: $struct0});
builder.endRecGroup();

builder.addFunction("make", makeSig([kWasmExternRef], [kWasmAnyRef]))
  .exportFunc()
  .addBody([kExprLocalGet, 0,
            kGCPrefix, 0x00, $desc0,   // StructNew
            kGCPrefix, 0x21, $struct0, // StructNewDefaultDesc
            ]);

let instance = builder.instantiate();

let proto1 = { c: 42 };

let wasm_obj1 = instance.exports.make(proto1);
let wasm_obj2 = instance.exports.make(wasm_obj1); // wasm_obj1 is prototype of wasm_obj2

function foo(obj) {
  return obj[0];
}

%PrepareFunctionForOptimization(foo);
foo(wasm_obj2);
foo(wasm_obj2);
%OptimizeFunctionOnNextCall(foo);
foo(wasm_obj2);

print("success!");
