PI = [];
PI[250] = PI;
Object.seal(PI);
Object.freeze(new Proxy(PI, PI));
[70];
