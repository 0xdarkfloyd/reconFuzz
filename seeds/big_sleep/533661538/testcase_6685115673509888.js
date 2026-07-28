function foo(b) {
  let x = b ? 1e300 : 2.5;
  let y = b ? 1e300 : 3.5;
  let z = x ** y;
  let s = Math.min(z);
  let u = 1 / s;
  let w = b ? u : 2.5;
  let w2 = w + 0.0;
  let v = 1 / w2;
  return v > 1000;
}
%PrepareFunctionForOptimization(foo);
foo();
%OptimizeFunctionOnNextCall(foo);
foo(true);