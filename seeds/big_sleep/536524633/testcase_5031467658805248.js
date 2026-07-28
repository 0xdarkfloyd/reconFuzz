
function f() {
  let r = /a/g;
  r.lastIndex = 2147483647;
  return r.test("ab");
}
%PrepareFunctionForOptimization(f);
f();
f();
%OptimizeMaglevOnNextCall(f);
f();
