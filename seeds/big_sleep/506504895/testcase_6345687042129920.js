// Flags: --specialize-code-for-one-byte-seq-strings

function makeSeqString(c, len) {
  var args = Array(len).fill(c.charCodeAt(0));
  return String.fromCharCode(...args);
}

var table = "A".repeat(20);
var o = {}; o[table] = 1;

function foo(b, s1, s2) {
  var d1 = s1[0];
  var d2 = s2[0];
  var s = b ? s1 : s2;
  var c1 = s.charCodeAt(0);
  Symbol.for(s);
  var c2 = s.charCodeAt(0);
  return [c1, c2];
}

%PrepareFunctionForOptimization(foo);
for (var i = 0; i < 100; i++) {
  foo(true, makeSeqString('A', 20), makeSeqString('B', 20));
  foo(false, makeSeqString('A', 20), makeSeqString('B', 20));
}
%OptimizeMaglevOnNextCall(foo);
foo(true, makeSeqString('A', 20), makeSeqString('B', 20));
