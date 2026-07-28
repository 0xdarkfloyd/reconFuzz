d8.file.execute('test/mjsunit/wasm/wasm-module-builder.js');
var builder = new WasmModuleBuilder();
builder.addFunction("f", kSig_i_l)
  .addBody([kExprI32Const, 42])
  .exportAs("f");
var instance = builder.instantiate();
var f = instance.exports.f;
function caller(obj) {
  var res = f(obj);
  return res;
}
var obj = {
  valueOf: function() {
    %DeoptimizeFunction(caller);
    return 1n;
  }
};
%PrepareFunctionForOptimization(caller);
caller(1n);
%OptimizeFunctionOnNextCall(caller);
var res = caller(obj);