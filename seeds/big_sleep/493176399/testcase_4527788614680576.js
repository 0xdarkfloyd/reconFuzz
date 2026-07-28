function foo(obj) {
  return obj.p;
}
let ab1 = new ArrayBuffer();
let ta1 = new Int32Array(ab1);
%ArrayBufferDetach(ab1);
ta1.p = 1; 
%PrepareFunctionForOptimization(foo);
foo(ta1);
let ab2 = new ArrayBuffer();
let ta2 = new Int32Array(ab2);
%ArrayBufferDetach(ab2);
ta2.p = 1.1; 
%OptimizeFunctionOnNextCall(foo);
foo();