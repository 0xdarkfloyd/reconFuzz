Realm.createAllowCrossRealmAccess();
function f() {
  return Temporal.Instant;
}
let f_1 = Realm.eval(1, f + " f");
Realm.navigate(1);
f_1();
