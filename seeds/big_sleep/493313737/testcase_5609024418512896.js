// Flags: --js-defer-import-eval --module
import defer * as ns from "data:text/javascript,export const foo = 42;";

function AsmModule(stdlib, foreign) {
  "use asm";
  var foo = foreign.foo | 0;
  function bar() { return foo | 0; }
  return { bar: bar };
}

try {
  print("Instantiating asm.js module...");
  AsmModule(this, ns);
  print("Success (unexpected)");
} catch (e) {
  print("Caught: " + e);
}
