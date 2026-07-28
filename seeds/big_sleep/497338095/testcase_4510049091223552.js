// Flags: --harmony-shadow-realm

const sr = new ShadowRealm();
const code = 'export const then = (f, r) => { f({not_a_namespace: true}); };';
const url = 'data:text/javascript,' + code;

sr.importValue(url, 'foo').then(
  val => print('Fulfilled with:', val),
  err => print('Rejected with:', err)
);
