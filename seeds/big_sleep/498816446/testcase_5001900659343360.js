// Flags: --maglev-object-tracking
let f64 = new Float64Array(1);
f64[0] = 4;

function foo() {
  let x = Math.sqrt(f64[0]);
  let arr = new Array(x);
  let iter = arr.values();
  return iter.next();
}

%PrepareFunctionForOptimization(foo);
foo();
foo();
%OptimizeMaglevOnNextCall(foo);
foo();
