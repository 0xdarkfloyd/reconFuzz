function test() {
  function grand_outer() {
    try {
      outer();
    } catch (e) {
      print(e.name);
    }
    
    let x = 42;
    
    function outer() {
      eval(""); // trigger sloppy_eval_can_extend_vars
      function f() {
        return x;
      }
      try {
        let h = f();
        print("Hole leaked: " + h);
      } catch (e) {
        print(e.name);
      }
    }
  }
  grand_outer();
}
test();
