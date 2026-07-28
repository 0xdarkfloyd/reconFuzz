let get_p;
class C {
  get #m() { return "PRIVATE"; }
  [ (() => {
      get_p =o => o.#m;
      %PrepareFunctionForOptimization(get_p);
      try { get_p(); } catch(e) {}
      %OptimizeMaglevOnNextCall(get_p);
      try { get_p(); } catch(e) {}
  })() ] = 1;
}
let c = new C();
"Result: " + get_p(c);