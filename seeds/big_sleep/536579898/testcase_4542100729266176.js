// Flags: --allow-natives-syntax --maglev-object-tracking
function f() {
  let r = /a/g;
  r.lastIndex = 1073741824;
  return r.test("abc");
}

%PrepareFunctionForOptimization(f);
f();
f();
%OptimizeMaglevOnNextCall(f);
f();
