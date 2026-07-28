function callee(
  p0, p1, p2, p3, p4, p5, p6, p7, p8, p9,
  p10, p11, p12, p13, p14, p15, p16, p17, p18, p19,
  p20, p21, p22, p23, p24, p25, p26, p27, p28, p29,
  p30, p31
) {
  'use strict';
  return p31;
}

function caller() {
  return callee(
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    30, 31
  );
}

%PrepareFunctionForOptimization(callee);
%PrepareFunctionForOptimization(caller);
caller();
caller();
%OptimizeMaglevOnNextCall(caller);
let res = caller();

// Let's inspect 'res' safely without triggering print()'s CHECK
let t = typeof res;
let is_undefined = (res === undefined);
let is_null = (res === null);
let is_optimized_out = (%DebugPrint(res)); // This might crash or print
