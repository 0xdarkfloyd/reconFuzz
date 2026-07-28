// Flags: --allow-natives-syntax

try {
  const max_len = 536870888;
  const str_len = max_len - 24; // 536870864
  const long_str = "A".repeat(str_len);
  const num = -1.2000000000000002e-6;

  function make_foo(s) {
    function foo() {
      try {
        return num + s;
      } catch (e) {
        return e.message;
      }
    }
    return foo;
  }

  const foo = make_foo(long_str);

  %PrepareFunctionForOptimization(foo);
  foo();
  %OptimizeFunctionOnNextCall(foo);
  foo();
  print("Done");
} catch (e) {
  print("Error: " + e);
}
