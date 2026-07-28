Realm.createAllowCrossRealmAccess();
let f_1 = Realm.eval(1, "function f() {} f");
f_1.prototype = 42;
Realm.navigate(1);
try {
  Reflect.construct(Temporal.Instant, [0n], f_1);
} catch (e) {
  print("Caught: " + e);
}
