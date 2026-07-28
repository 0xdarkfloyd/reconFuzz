// Flags: --fast-proxy-ic
class MyTrap {
  constructor( p, r) {
  }
}
const handler = {
  get: MyTrap
};
const proxy = new Proxy({a: 1}, handler);
function test(p) {
  return p.a;
}

%PrepareFunctionForOptimization(test);
try { test(proxy); } catch(e) { print(e); }
try { test(proxy); } catch(e) { print(e); }