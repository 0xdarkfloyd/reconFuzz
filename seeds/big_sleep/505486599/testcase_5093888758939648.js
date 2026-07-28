let r1 = Realm.create();
let r2 = Realm.create();
let f = Realm.eval(r1, `(function f(r2) { 
  Realm.switch(r2); 
  throw new Error('foo'); 
})`);
let g = Realm.eval(r1, "(function g() { print('In g'); })");

Promise.resolve().then(() => f(r2)).catch(e => {});
Promise.resolve().then(g);
